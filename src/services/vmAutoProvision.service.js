// Fully automated VM creation: server runs `az login --use-device-code` in an
// isolated Azure CLI config (so concurrent participants never collide), then
// runs the same terraform/participant-vm config deploy.sh uses — but as a
// child process here, driven by that participant's own freshly-authenticated
// Azure CLI session, so the VM lands in *their* Azure subscription without
// them running anything locally.
//
// This deliberately does NOT use the browser's MSAL access token: Terraform's
// azurerm provider has no supported "hand me a bearer token" auth mode (its
// options are Azure CLI, a Service Principal, Managed Identity, or OIDC
// federation) — Azure CLI is the one that actually works here, so the device
// code is a second, separate Azure sign-in from the MSAL identity check the
// participant already did.

import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendProvisioningEvent } from './vmProvisioning.service.js';
import { registerOwnerVm, registerProviderToken } from './flSessionAuto.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..', '..');
const TF_DIR = path.join(REPO_ROOT, 'terraform', 'participant-vm');

// `terraform apply`'s raw output (including everything the remote-exec/
// local-exec provisioners print from inside the VM) is otherwise only ever
// held in the runCommand() closure below and discarded the moment the
// promise settles - on failure the UI only ever saw the generic "Process
// exited with status 1" summary, with no way to find out what the script
// actually hit. Every apply's full output gets written here so a failure can
// be diagnosed after the fact without SSHing into the VM.
const PROVISIONING_LOG_DIR = path.join(REPO_ROOT, 'logs', 'vm-provisioning');

// Shared, persistent cache of downloaded provider plugins (azurerm is large)
// so concurrent runs' `terraform init` calls reuse one download instead of
// each fetching it again - see TF_PLUGIN_CACHE_DIR below.
const PLUGIN_CACHE_DIR = path.join(TF_DIR, '.terraform-plugin-cache');

// terraform is installed to ~/.local/bin (no sudo needed) rather than
// somewhere already on this process's PATH, so make sure spawned commands
// can find it regardless of how p3dx-aaa itself was started.
const EXTRA_PATH = path.join(os.homedir(), '.local', 'bin');
const BASE_ENV = { ...process.env, PATH: `${EXTRA_PATH}:${process.env.PATH || ''}` };

const privateKeys = new Map(); // provisioning token -> PEM text, cleared on first download

// One provisioning run per runKey at a time. runKey is an opaque id the
// caller supplies (VmProvisioningPanel generates one per component instance)
// rather than username, so multiple *different* panels/sessions - even under
// the same orchestrator account - can run concurrently. Without this guard, a
// React remount (StrictMode's double-invoke, a page refresh mid-flow, the
// panel re-rendering) of the *same* instance would each spawn its own
// `az login --use-device-code` - and each call gets a *different* device
// code, so whichever one the person actually completes may not be the
// process still shown in their panel. The client-side guard (a useRef in
// VmProvisioningPanel) only protects one component instance, not repeated
// mounts, so this needs to be enforced here too.
const activeRunKeys = new Set();

export function isProvisioning(runKey) {
  return activeRunKeys.has(runKey);
}

// Copies just the terraform *source* (not state, not .terraform/) into an
// isolated per-run directory, so concurrent runs never share a working
// directory - each gets its own `.terraform/`, so nothing races on a shared
// `.terraform/environment` workspace pointer or a shared provider-plugin
// install anymore. State still lands in the one persistent, shared location
// per participant it always has (see statePath in runAutoProvision below).
//
// runRoot mirrors this repo's own layout (terraform/participant-vm two
// levels under the root) rather than copying TF_DIR in isolation, because
// main.tf's dataset-generation script reaches out via
// `${path.module}/../../Flotilla_Deployment/generate_dataset.py` - a bare
// copy of TF_DIR alone would leave that relative reference dangling.
async function copyTerraformSource(runRoot) {
  const destDir = path.join(runRoot, 'terraform', 'participant-vm');
  await mkdir(destDir, { recursive: true });
  const entries = ['main.tf', 'variables.tf', 'outputs.tf', 'versions.tf', 'templates', '.terraform.lock.hcl'];
  for (const entry of entries) {
    await cp(path.join(TF_DIR, entry), path.join(destDir, entry), { recursive: true }).catch((err) => {
      if (err.code !== 'ENOENT') throw err;
    });
  }
  const externalFiles = [
    path.join('Flotilla_Deployment', 'generate_dataset.py'),
    path.join('Flotilla_Deployment', 'deployment', 'mosquitto.conf'),
  ];
  for (const rel of externalFiles) {
    await mkdir(path.join(runRoot, path.dirname(rel)), { recursive: true });
    await cp(path.join(REPO_ROOT, rel), path.join(runRoot, rel));
  }
  return destDir;
}

function slugify(name) {
  const slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 22);
  return slug || 'participant';
}

function runCommand({ command, args, cwd, env, onLine }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env });
    let stdout = '';
    let stderr = '';

    const handle = (isErr) => (chunk) => {
      const text = chunk.toString();
      if (isErr) stderr += text; else stdout += text;
      if (onLine) {
        text.split('\n').forEach((line) => {
          if (line.trim()) onLine(line.trim());
        });
      }
    };
    child.stdout.on('data', handle(false));
    child.stderr.on('data', handle(true));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        // stderr alone is usually just terraform's own generic summary
        // ("Error: remote-exec provisioner error... exit status 1") - the
        // actual cause a provisioner script printed goes to stdout. Combine
        // both so that detail isn't silently dropped from the error message.
        const combined = `${stdout}\n${stderr}`.trim();
        const err = new Error(`${command} ${args.join(' ')} failed (exit ${code}): ${combined.slice(-2000)}`);
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// appendProvisioningEvent alone is invisible in the server log (it only
// updates in-memory state for the SSE stream) — log alongside it so a run
// can be traced without having to inspect processes directly.
function makeEventLogger(token, username) {
  return (e) => {
    appendProvisioningEvent({ token, ...e });
    console.log(`[vm-auto-provision] ${username}: ${e.step} — ${e.status}${e.message ? ` (${e.message})` : ''}`);
  };
}

// Runs the device-code login, streaming the code/URL out as a provisioning
// event the moment Azure CLI prints it, so the panel can show it immediately
// rather than the participant staring at "signing in...".
async function deviceCodeLogin({ env, event }) {
  let announced = false;
  await runCommand({
    command: 'az',
    args: ['login', '--use-device-code'],
    env,
    onLine: (line) => {
      if (!announced && /devicelogin|enter the code/i.test(line)) {
        announced = true;
        event({ step: 'Azure device login', status: 'running', message: line });
      }
    },
  });
}

export async function runAutoProvision({ token, username, role, vmName, runKey, submissionId }) {
  if (activeRunKeys.has(runKey)) {
    appendProvisioningEvent({
      token, step: 'Starting', status: 'error',
      message: 'A provisioning run for you is already in progress — check for an earlier device code rather than starting a new one.',
    });
    return;
  }
  activeRunKeys.add(runKey);
  if (role === 'data-provider' && submissionId) registerProviderToken(submissionId, token);

  const event = makeEventLogger(token, username);
  // The VM (and its RG/vnet/NSG/disk/workspace) is named after the
  // participant-chosen vmName, not their username/id.
  const participantName = slugify(vmName);
  let workDir = null;
  const applyOutputLines = [];

  try {
    event({
      step: 'Starting', status: 'running',
      message: `Provisioning VM "${vmName}" for ${username} (${role}) — this needs one more Azure sign-in for Terraform itself.`,
    });

    workDir = await mkdtemp(path.join(os.tmpdir(), 'p3dx-vm-'));
    const env = { ...BASE_ENV, AZURE_CONFIG_DIR: path.join(workDir, 'azure-config'), TF_IN_AUTOMATION: '1' };

    event({
      step: 'Azure device login', status: 'running', command: 'az login --use-device-code',
      message: 'Waiting for you to sign in via the code above...',
    });
    await deviceCodeLogin({ env, event });
    event({ step: 'Azure device login', status: 'ok', message: 'Signed in' });

    const { stdout: accountJson } = await runCommand({ command: 'az', args: ['account', 'show', '-o', 'json'], env });
    const account = JSON.parse(accountJson);
    event({ step: 'Azure account', status: 'ok', message: `Using subscription "${account.name}" (${account.id})` });

    const keyPath = path.join(workDir, 'id_ed25519');
    event({ step: 'SSH key', status: 'running', message: 'Generating a fresh SSH keypair for this VM' });
    await runCommand({
      command: 'ssh-keygen',
      args: ['-t', 'ed25519', '-N', '', '-f', keyPath, '-C', `p3dx-flo-${participantName}`],
      env,
    });
    event({ step: 'SSH key', status: 'ok' });

    const tfEnv = {
      ...env,
      TF_VAR_role: role,
      TF_VAR_participant_name: participantName,
      TF_VAR_created_by: account.user?.name || account.id,
      TF_VAR_ssh_public_key_path: `${keyPath}.pub`,
      TF_VAR_ssh_private_key_path: keyPath,
      // Lets the VM `docker login ghcr.io` and pull the pre-built
      // flotilla-server/client/session images instead of git-cloning and
      // building from source - see .env.example. Falls back to
      // variables.tf's own defaults (ghcr_namespace) / empty (ghcr_token) if
      // unset here, matching how gov_layer_url/gov_layer_token work.
      ...(process.env.GHCR_NAMESPACE ? { TF_VAR_ghcr_namespace: process.env.GHCR_NAMESPACE } : {}),
      ...(process.env.GHCR_PULL_TOKEN ? { TF_VAR_ghcr_token: process.env.GHCR_PULL_TOKEN } : {}),
    };

    // Runs in a private copy of the terraform config (see copyTerraformSource)
    // so this run's `.terraform/` never collides with another concurrent
    // run's - everything above this point (Azure login, SSH keygen) already
    // ran without waiting, and now so does this: no more queuing behind
    // other participants' VM creation. `-backend-config` points this private
    // copy at the SAME persistent state file this participant's workspace has
    // always used (terraform.tfstate.d/<name>/terraform.tfstate under
    // TF_DIR), so nothing about where state lives actually changes.
    const statePath = path.join(TF_DIR, 'terraform.tfstate.d', participantName, 'terraform.tfstate');
    await mkdir(PLUGIN_CACHE_DIR, { recursive: true });
    await mkdir(path.dirname(statePath), { recursive: true });
    tfEnv.TF_PLUGIN_CACHE_DIR = PLUGIN_CACHE_DIR;

    event({ step: 'Preparing Terraform config', status: 'running', message: 'Setting up an isolated working directory for this run' });
    const runTfDir = await copyTerraformSource(workDir);
    event({ step: 'Preparing Terraform config', status: 'ok' });

    event({ step: 'Terraform init', status: 'running', command: 'terraform init -input=false' });
    await runCommand({
      command: 'terraform',
      args: ['init', '-input=false', '-no-color', `-backend-config=path=${statePath}`],
      cwd: runTfDir,
      env: tfEnv,
    });
    event({ step: 'Terraform init', status: 'ok' });

    event({ step: 'Creating VM', status: 'running', command: 'terraform apply -auto-approve -input=false' });
    // Once the VM exists, two provisioners stream progress as "STAGE: ..." /
    // "WARNING: ..." lines: wait_for_combine_fl SSHes into the VM itself
    // (cloud-init.sh.tftpl's install/clone/venv/requirements/dataset/broker
    // steps, tagged "(remote-exec):" by terraform) and configure_broker runs
    // locally right after (registering this VM with gov_layer and pointing
    // its combine_fl config at the output-owner, tagged "(local-exec):" —
    // see configure-broker.sh.tftpl). Surface each one as its own event
    // instead of one opaque "Creating VM" spinner for the whole apply.
    const remoteStageLineRe = /\(remote-exec\):\s*(?:STAGE|WARNING):\s*(.+)$/;
    const localStageLineRe = /\(local-exec\):\s*(?:STAGE|WARNING):\s*(.+)$/;
    await runCommand({
      command: 'terraform',
      args: ['apply', '-auto-approve', '-input=false', '-no-color'],
      cwd: runTfDir,
      env: tfEnv,
      onLine: (line) => {
        applyOutputLines.push(line);
        let m = remoteStageLineRe.exec(line);
        if (m) { event({ step: 'VM setup', status: 'running', message: m[1].trim() }); return; }
        m = localStageLineRe.exec(line);
        if (m) event({ step: 'Broker config', status: 'running', message: m[1].trim() });
      },
    });

    const { stdout: outputsJson } = await runCommand({ command: 'terraform', args: ['output', '-json'], cwd: runTfDir, env: tfEnv });
    const outputs = JSON.parse(outputsJson);
    const sshCommand = outputs?.ssh_command?.value;
    const createdVmName = outputs?.vm_name?.value;
    const publicIp = outputs?.public_ip_address?.value;

    if (role === 'user' && submissionId && publicIp) registerOwnerVm(submissionId, publicIp, token);

    privateKeys.set(token, await readFile(keyPath, 'utf8'));

    event({
      step: 'Creating VM', status: 'done',
      message: `VM "${createdVmName || participantName}" created.${sshCommand ? ` Connect: ${sshCommand}` : ''} Download your SSH key below.`,
    });
  } catch (err) {
    let message = err?.message || String(err);
    if (applyOutputLines.length) {
      const logPath = path.join(PROVISIONING_LOG_DIR, `${participantName}-${Date.now()}.log`);
      await mkdir(PROVISIONING_LOG_DIR, { recursive: true })
        .then(() => writeFile(logPath, applyOutputLines.join('\n')))
        .then(() => {
          // (remote-exec)/(local-exec) lines are the provisioner scripts'
          // own output (cloud-init.sh, configure-broker.sh); "Error:" lines
          // are terraform's own diagnostics - together these are what
          // actually explains an apply failure, unlike the generic "Process
          // exited with status 1" terraform reports on its own.
          const relevant = applyOutputLines.filter((l) => /\((remote|local)-exec\):/.test(l) || /^Error:/.test(l));
          const tail = relevant.slice(-15).join('\n');
          message = `${message}\n\nFull apply output saved to ${logPath}${tail ? `\n\nLast relevant lines:\n${tail}` : ''}`;
        })
        .catch(() => {});
    }
    event({ step: 'Provisioning failed', status: 'error', message });
  } finally {
    activeRunKeys.delete(runKey);
    if (workDir) {
      // On a failed run the VM may already exist (terraform apply can fail
      // partway through, e.g. wait_for_combine_fl timing out) with this run's
      // public key installed as its only admin_ssh_key — losing the matching
      // private key here would make that VM permanently unreachable. Stash it
      // in the same in-memory map the success path uses (download endpoint
      // doesn't care which path put it there) before wiping the temp dir.
      if (!privateKeys.has(token)) {
        await readFile(path.join(workDir, 'id_ed25519'), 'utf8')
          .then((key) => privateKeys.set(token, key))
          .catch(() => {});
      }
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// One-time retrieval of the SSH private key generated for one auto-created
// VM run, identified by its provisioning token — cleared from memory as soon
// as it's downloaded.
export function takePrivateKey(token) {
  const key = privateKeys.get(token);
  privateKeys.delete(token);
  return key || null;
}