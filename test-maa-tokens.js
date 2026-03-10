import 'dotenv/config';
import axios from 'axios';
import pkg from 'immudb-node';

function getBaseUrl() {
  return process.env.BASE_URL || 'http://localhost:3001';
}

function getUsername() {
  return process.env.TEST_USERNAME;
}

function getPassword() {
  return process.env.TEST_PASSWORD;
}

function shouldAutoRegister() {
  const v = (process.env.AUTO_REGISTER || 'true').trim().toLowerCase();
  return v !== 'false' && v !== '0' && v !== 'no';
}

function randomSuffix() {
  return `${Date.now()}${Math.floor(Math.random() * 10000)}`;
}

function getSubmitMode() {
  const mode = (process.env.SUBMIT_MODE || 'json').trim().toLowerCase();
  return mode === 'text' ? 'text' : 'json';
}

async function verifyImmuDbMaaKeys() {
  const host = process.env.IMMUDB_HOST;
  const portRaw = process.env.IMMUDB_PORT;
  const user = process.env.IMMUDB_USER;
  const password = process.env.IMMUDB_PASSWORD;
  const database = process.env.IMMUDB_DATABASE;

  const port = Number.parseInt(portRaw, 10);

  if (!host || !portRaw || Number.isNaN(port) || !user || !password || !database) {
    console.warn('[test:maa] immuDB env vars not set (IMMUDB_HOST/PORT/USER/PASSWORD/DATABASE). Skipping immuDB key scan.');
    return;
  }

  try {
    const ImmudbClient = pkg.default;
    const client = new ImmudbClient({ host, port });

    await client.login({ user, password });
    await client.useDatabase({ databasename: database });

    const page = await client.scan({
      prefix: 'maa:',
      limit: 50,
    });

    const entries = page?.entriesList || [];
    console.log(`[test:maa] immuDB scan maa: found ${entries.length} entries (showing up to 10 keys)`);

    for (const entry of entries.slice(0, 10)) {
      console.log(`[test:maa] immuDB key: ${entry.key}`);
    }
  } catch (err) {
    console.warn(`[test:maa] immuDB scan failed: ${err.message}`);
  }
}

async function main() {
  const baseUrl = getBaseUrl();
  let username = getUsername();
  let password = getPassword();
  const submitMode = getSubmitMode();
  const autoRegister = shouldAutoRegister();

  if (!username) {
    username = `maa_test_${randomSuffix()}`;
  }

  if (!password) {
    password = `TestPass_${randomSuffix()}!`;
  }

  const maaTokensRaw = process.env.MAA_TOKENS;
  const maaTokens = maaTokensRaw
    ? maaTokensRaw.split(',').map(t => t.trim()).filter(Boolean)
    : ['maa.jwt.token.1', 'maa.jwt.token.2'];

  console.log(`[test:maa] Base URL: ${baseUrl}`);
  console.log(`[test:maa] Username: ${username}`);
  console.log(`[test:maa] Auto register: ${autoRegister}`);
  console.log(`[test:maa] MAA tokens: ${maaTokens.length}`);
  console.log(`[test:maa] Submit mode: ${submitMode}`);

  try {
    let loginRes;
    try {
      loginRes = await axios.post(
        `${baseUrl}/p3dx/login`,
        { username, password },
        { headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      const status = err.response?.status;
      const errorCode = err.response?.data?.error;

      if (autoRegister && status === 401 && errorCode === 'INVALID_CREDENTIALS') {
        console.log('[test:maa] Login failed; attempting auto-register...');

        await axios.post(
          `${baseUrl}/p3dx/register`,
          {
            username,
            email: `${username}@example.com`,
            password,
            firstName: 'MAA',
            lastName: 'Test',
          },
          { headers: { 'Content-Type': 'application/json' } }
        );

        console.log('[test:maa] Register OK; retrying login...');

        loginRes = await axios.post(
          `${baseUrl}/p3dx/login`,
          { username, password },
          { headers: { 'Content-Type': 'application/json' } }
        );
      } else {
        throw err;
      }
    }

    const accessToken = loginRes.data?.access_token;
    if (!accessToken) {
      console.error('[test:maa] Login did not return access_token:', loginRes.data);
      process.exit(1);
    }

    console.log('[test:maa] Login OK');

    const submitRes = submitMode === 'text'
      ? await axios.post(
        `${baseUrl}/p3dx/maa-tokens`,
        `${maaTokens.join('\n')}\n`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'text/plain',
          },
        }
      )
      : await axios.post(
        `${baseUrl}/p3dx/maa-tokens`,
        { maa_tokens: maaTokens },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

    console.log('[test:maa] /p3dx/maa-tokens response:', submitRes.data);

    const meRes = await axios.get(`${baseUrl}/p3dx/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    console.log('[test:maa] /p3dx/me response:', meRes.data);

    await verifyImmuDbMaaKeys();

    console.log('[test:maa] DONE');
  } catch (err) {
    if (err.response) {
      console.error('[test:maa] HTTP ERROR', err.response.status, err.response.data);
    } else {
      console.error('[test:maa] ERROR', err.message);
    }
    process.exit(1);
  }
}

main();
