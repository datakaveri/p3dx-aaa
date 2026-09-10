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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendProvisioningEvent } from './vmProvisioning.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TF_DIR = path.resolve(here, '..', '..', '..', 'terraform', 'participant-vm');

// terraform is installed to ~/.local/bin (no sudo needed) rather than
// somewhere already on this process's PATH, so make sure spawned commands
// can find it regardless of how p3dx-aaa itself was started.
const EXTRA_PATH = path.join(os.homedir(), '.local', 'bin');
const BASE_ENV = { ...process.env, PATH: `${EXTRA_PATH}:${process.env.PATH || ''}` };

const privateKeys = new Map(); // username -> PEM text, cleared on first download

// One provisioning run per username at a time. Without this, a React
// remount (StrictMode's double-invoke, a page refresh mid-flow, the panel
// re-rendering) each spawns its own `az login --use-device-code` - and each
// call gets a *different* device code, so whichever one the person actually
// completes may not be the process still shown in their panel. The
// client-side guard (a useRef in VmProvisioningPanel) only protects one
// component instance, not repeated mounts, so this needs to be enforced here
// too.
const activeUsernames = new Set();

export function isProvisioning(username) {
  return activeUsernames.has(username);
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
        const err = new Error(`${command} ${args.join(' ')} failed (exit ${code}): ${(stderr || stdout).slice(-2000)}`);
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

export async function runAutoProvision({ token, username, role, vmName }) {
  if (activeUsernames.has(username)) {
    appendProvisioningEvent({
      token, step: 'Starting', status: 'error',
      message: 'A provisioning run for you is already in progress — check for an earlier device code rather than starting a new one.',
    });
    return;
  }
  activeUsernames.add(username);

  const event = makeEventLogger(token, username);
  // The VM (and its RG/vnet/NSG/disk/workspace) is named after the
  // participant-chosen vmName, not their username/id - username still keys
  // the in-flight-run guard and the SSH-key handoff above, which are about
  // this account's session, not the VM identity.
  const participantName = slugify(vmName);
  let workDir = null;

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
    };

    event({ step: 'Terraform init', status: 'running', command: 'terraform init -input=false' });
    await runCommand({ command: 'terraform', args: ['init', '-input=false', '-no-color'], cwd: TF_DIR, env: tfEnv });
    event({ step: 'Terraform init', status: 'ok' });

    await runCommand({ command: 'terraform', args: ['workspace', 'select', '-or-create', participantName], cwd: TF_DIR, env: tfEnv });

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
      cwd: TF_DIR,
      env: tfEnv,
      onLine: (line) => {
        let m = remoteStageLineRe.exec(line);
        if (m) { event({ step: 'VM setup', status: 'running', message: m[1].trim() }); return; }
        m = localStageLineRe.exec(line);
        if (m) event({ step: 'Broker config', status: 'running', message: m[1].trim() });
      },
    });

    const { stdout: outputsJson } = await runCommand({ command: 'terraform', args: ['output', '-json'], cwd: TF_DIR, env: tfEnv });
    const outputs = JSON.parse(outputsJson);
    const sshCommand = outputs?.ssh_command?.value;
    const createdVmName = outputs?.vm_name?.value;

    privateKeys.set(username, await readFile(keyPath, 'utf8'));

    event({
      step: 'Creating VM', status: 'done',
      message: `VM "${createdVmName || participantName}" created.${sshCommand ? ` Connect: ${sshCommand}` : ''} Download your SSH key below.`,
    });
  } catch (err) {
    event({ step: 'Provisioning failed', status: 'error', message: err?.message || String(err) });
  } finally {
    activeUsernames.delete(username);
    if (workDir) {
      // On a failed run the VM may already exist (terraform apply can fail
      // partway through, e.g. wait_for_combine_fl timing out) with this run's
      // public key installed as its only admin_ssh_key — losing the matching
      // private key here would make that VM permanently unreachable. Stash it
      // in the same in-memory map the success path uses (download endpoint
      // doesn't care which path put it there) before wiping the temp dir.
      if (!privateKeys.has(username)) {
        await readFile(path.join(workDir, 'id_ed25519'), 'utf8')
          .then((key) => privateKeys.set(username, key))
          .catch(() => {});
      }
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// One-time retrieval of the SSH private key generated for this user's most
// recent auto-created VM — cleared from memory as soon as it's downloaded.
export function takePrivateKey(username) {
  const key = privateKeys.get(username);
  privateKeys.delete(username);
  return key || null;
}