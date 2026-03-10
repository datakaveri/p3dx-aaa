import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readTextFromStream(stream) {
  return new Promise((resolve, reject) => {
    let data = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      data += chunk;
    });
    stream.on('end', () => resolve(data));
    stream.on('error', reject);
  });
}

function runProcess({ command, args, cwd, inputJson }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const stdoutPromise = readTextFromStream(child.stdout);
    const stderrPromise = readTextFromStream(child.stderr);

    child.on('error', reject);

    child.on('close', async code => {
      const stdout = await stdoutPromise;
      const stderr = await stderrPromise;

      if (code !== 0) {
        const err = new Error(`contract generator failed (exit=${code}): ${stderr || stdout}`);
        err.code = code;
        err.stderr = stderr;
        err.stdout = stdout;
        reject(err);
        return;
      }

      resolve({ stdout, stderr });
    });

    child.stdin.write(JSON.stringify(inputJson));
    child.stdin.end();
  });
}

function parseJsonFromStdout(stdout) {
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error('CONTRACT_GEN_EMPTY_OUTPUT');
  }

  try {
    return JSON.parse(text);
  } catch (err) {
    const e = new Error('CONTRACT_GEN_INVALID_JSON');
    e.detail = text;
    e.cause = err;
    throw e;
  }
}

export async function createWorkloadContract({ jwt, datasetId, applicationId }) {
  const contractGenBinRaw = process.env.CONTRACT_GEN_BIN;
  const contractGenBin = typeof contractGenBinRaw === 'string' ? contractGenBinRaw.trim() : '';

  const inputJson = {
    jwt,
    datasetId,
    applicationId,
  };

  if (contractGenBin) {
    const { stdout } = await runProcess({
      command: contractGenBin,
      args: [],
      cwd: process.cwd(),
      inputJson,
    });

    return parseJsonFromStdout(stdout);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const cwd = path.resolve(here, '..', '..', 'contract-gen');

  const { stdout } = await runProcess({
    command: 'go',
    args: ['run', '.'],
    cwd,
    inputJson,
  });

  return parseJsonFromStdout(stdout);
}
