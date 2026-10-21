import axios from 'axios';
import { getKeycloakConfig as readKeycloakConfig } from '../config/keycloak.js';

function getKeycloakConfig() {
  const cfg = readKeycloakConfig();
  const baseUrlRaw = cfg?.baseUrl;
  const realmRaw = cfg?.realm;

  const baseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw.trim() : '';
  const realm = typeof realmRaw === 'string' ? realmRaw.trim() : '';

  if (!baseUrl || !realm) {
    throw new Error(
      `Keycloak env not configured. Required KEYCLOAK_BASE_URL and KEYCLOAK_REALM. Got KEYCLOAK_BASE_URL='${baseUrlRaw ?? ''}' KEYCLOAK_REALM='${realmRaw ?? ''}'`
    );
  }

  return {
    baseUrl,
    realm,
    adminUser: cfg?.adminUser,
    adminPassword: cfg?.adminPassword,
    clientId: cfg?.clientId,
    clientSecret: cfg?.clientSecret,
  };
}

/**
 * Get admin access token (short-lived)
 */
export async function getAdminToken() {
  const { baseUrl, realm, adminUser, adminPassword } = getKeycloakConfig();
  const url = `${baseUrl}/realms/${realm}/protocol/openid-connect/token`;

  const params = new URLSearchParams();
  params.append('grant_type', 'password');
  params.append('client_id', 'admin-cli');
  params.append('username', adminUser);
  params.append('password', adminPassword);

  const response = await axios.post(url, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return response.data.access_token;
}

/**
 * Create a new user in Keycloak
 */
export async function createUser(user, adminToken) {
  const { baseUrl, realm } = getKeycloakConfig();
  const url = `${baseUrl}/admin/realms/${realm}/users`;

  await axios.post(
    url,
    {
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      enabled: true,
      emailVerified: true,
      requiredActions: [],
      credentials: [
        {
          type: 'password',
          value: user.password,
          temporary: false,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Get Keycloak user ID by username
 */
export async function getUserId(username, adminToken) {
  const { baseUrl, realm } = getKeycloakConfig();
  const url = `${baseUrl}/admin/realms/${realm}/users`;

  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${adminToken}`,
    },
    params: { username },
  });

  if (!response.data.length) {
    throw new Error('USER_NOT_FOUND');
  }

  return response.data[0].id;
}

/**
 * List every user holding a given realm role (e.g. "data-provider") — the
 * real provider directory, as opposed to any mock/static list.
 */
export async function getUsersByRole(roleName, adminToken) {
  const { baseUrl, realm } = getKeycloakConfig();
  const url = `${baseUrl}/admin/realms/${realm}/roles/${encodeURIComponent(roleName)}/users`;

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  return response.data;
}

export async function assignRealmRole(userId, roleName, adminToken) {
  const { baseUrl, realm } = getKeycloakConfig();

  const roleUrl = `${baseUrl}/admin/realms/${realm}/roles/${encodeURIComponent(roleName)}`;
  const rolesUrl = `${baseUrl}/admin/realms/${realm}/roles`;
  const mappingUrl = `${baseUrl}/admin/realms/${realm}/users/${userId}/role-mappings/realm`;

  let roleRes;
  try {
    roleRes = await axios.get(roleUrl, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  } catch (err) {
    if (err.response?.status === 404) {
      await axios.post(
        rolesUrl,
        {
          name: roleName,
        },
        {
          headers: {
            Authorization: `Bearer ${adminToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      roleRes = await axios.get(roleUrl, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
    } else {
      throw err;
    }
  }

  await axios.post(
    mappingUrl,
    [
      {
        id: roleRes.data.id,
        name: roleRes.data.name,
      },
    ],
    {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Assign realm role "user" to the user
 */
export async function assignUserRole(userId, adminToken) {
  await assignRealmRole(userId, 'user', adminToken);
}

/**
 * Fetch the full user representation by Keycloak user ID.
 */
export async function getUserById(userId, adminToken) {
  const { baseUrl, realm } = getKeycloakConfig();
  const url = `${baseUrl}/admin/realms/${realm}/users/${userId}`;

  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  return response.data;
}

/**
 * Set a single custom attribute on a user's Keycloak profile (e.g. a
 * data-provider public key). Merges into the user's existing attributes
 * rather than replacing them, and re-sends the full user representation
 * since Keycloak's user PUT does not do a partial attribute merge itself.
 */
export async function setUserAttribute(userId, attributeName, attributeValue, adminToken) {
  const { baseUrl, realm } = getKeycloakConfig();
  const user = await getUserById(userId, adminToken);

  const attributes = { ...(user.attributes || {}) };
  attributes[attributeName] = [attributeValue];

  const url = `${baseUrl}/admin/realms/${realm}/users/${userId}`;
  await axios.put(
    url,
    { ...user, attributes },
    {
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

/**
 * Login user using ROPC
 */
export async function loginUser(username, password) {
  const { baseUrl, realm, clientId, clientSecret } = getKeycloakConfig();
  const url = `${baseUrl}/realms/${realm}/protocol/openid-connect/token`;

  const params = new URLSearchParams();
  params.append('grant_type', 'password');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('username', username);
  params.append('password', password);
  params.append('scope', 'openid');

  const response = await axios.post(url, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return response.data;
}

/**
 * Exchange a refresh token for a new access token. Keycloak recomputes
 * realm_access.roles at issuance, so this is how a client picks up a role
 * granted after the current access token was issued, without a full re-login.
 */
export async function refreshAccessToken(refreshToken) {
  const { baseUrl, realm, clientId, clientSecret } = getKeycloakConfig();
  const url = `${baseUrl}/realms/${realm}/protocol/openid-connect/token`;

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('refresh_token', refreshToken);

  const response = await axios.post(url, params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });

  return response.data;
}

// ---------------------------------------------------------------------------
// Flotilla FL client-VM credentials (join gateway). The `flotilla-vm`
// confidential client is direct-grant only with full scope off, so its tokens
// carry azp=flotilla-vm and only the data-provider/offline_access roles.
// verifyJWT refuses azp=flotilla-vm tokens everywhere except the gateway
// route that issues them access tokens (/p3dx/fl/vm-token).
// NOTE: none of these helpers may log their inputs or Keycloak's response —
// they carry the provider's password and the offline/access tokens. Axios
// errors thrown from here also carry the request body in err.config.data, so
// callers must only ever log err.message / err.response.status.
// ---------------------------------------------------------------------------

export function getFlotillaVmClientConfig() {
  const clientId = String(process.env.FLOTILLA_VM_CLIENT_ID || 'flotilla-vm').trim();
  const clientSecret = String(process.env.FLOTILLA_VM_CLIENT_SECRET || '').trim();
  return { clientId, clientSecret };
}

function tokenEndpoint() {
  const { baseUrl, realm } = getKeycloakConfig();
  return `${baseUrl}/realms/${realm}/protocol/openid-connect/token`;
}

/**
 * Password grant against the flotilla-vm client asking for an offline token
 * (scope offline_access). Returns Keycloak's token response
 * ({access_token, refresh_token (typ Offline), expires_in, ...}).
 */
export async function loginForVmOfflineToken(username, password) {
  const { clientId, clientSecret } = getFlotillaVmClientConfig();
  if (!clientSecret) {
    throw new Error('FLOTILLA_VM_CLIENT_SECRET_NOT_SET');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'password');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('username', username);
  params.append('password', password);
  params.append('scope', 'openid offline_access');

  const response = await axios.post(tokenEndpoint(), params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });

  return response.data;
}

/**
 * Refresh grant with the flotilla-vm client. Keycloak returns a new
 * refresh_token string on every refresh (the old one stays usable unless the
 * realm has "Revoke Refresh Token" on), so callers treat any change as a
 * rotation.
 */
export async function refreshVmToken(offlineToken) {
  const { clientId, clientSecret } = getFlotillaVmClientConfig();
  if (!clientSecret) {
    throw new Error('FLOTILLA_VM_CLIENT_SECRET_NOT_SET');
  }

  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('client_id', clientId);
  params.append('client_secret', clientSecret);
  params.append('refresh_token', offlineToken);

  const response = await axios.post(tokenEndpoint(), params, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 10000,
  });

  return response.data;
}

const clientUuidCache = new Map();

/**
 * Resolve a client's internal UUID from its clientId (cached per process).
 */
export async function getClientUuid(clientId, adminToken) {
  if (clientUuidCache.has(clientId)) {
    return clientUuidCache.get(clientId);
  }
  const { baseUrl, realm } = getKeycloakConfig();
  const response = await axios.get(`${baseUrl}/admin/realms/${realm}/clients`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    params: { clientId },
    timeout: 10000,
  });
  const match = (response.data || []).find(c => c.clientId === clientId);
  if (!match?.id) {
    throw new Error('CLIENT_NOT_FOUND');
  }
  clientUuidCache.set(clientId, match.id);
  return match.id;
}

/**
 * Delete ONE offline user session by its session id (the `sid` claim).
 *
 * Keycloak 26 Admin API: DELETE /admin/realms/{realm}/sessions/{id}?isOffline=true
 * Verified live against Keycloak 26.0.8: returns 204, the session disappears
 * from GET /clients/{uuid}/offline-sessions, and a subsequent refresh with
 * that offline token fails with 400 invalid_grant "Offline user session not
 * found".
 * The per-user consent revoke (DELETE /users/{id}/consents/{clientId}) is NOT
 * used: it drops every offline session of that user for the client, not just
 * this credential's.
 *
 * Returns true if deleted, false if Keycloak says it was already gone.
 */
export async function deleteOfflineSession(sessionId) {
  if (!sessionId) {
    return false;
  }
  const { baseUrl, realm } = getKeycloakConfig();
  const adminToken = await getAdminToken();
  const resp = await axios.delete(
    `${baseUrl}/admin/realms/${realm}/sessions/${encodeURIComponent(sessionId)}`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      params: { isOffline: true },
      timeout: 10000,
      validateStatus: () => true,
    }
  );
  if (resp.status === 204 || resp.status === 200) {
    return true;
  }
  if (resp.status === 404) {
    return false;
  }
  const err = new Error(`DELETE_OFFLINE_SESSION_FAILED: status ${resp.status}`);
  err.statusCode = resp.status;
  throw err;
}

/**
 * Every offline session held by the flotilla-vm client
 * (GET /admin/realms/{realm}/clients/{uuid}/offline-sessions, paged).
 * Each item has at least {id, username, userId, start, lastAccess}.
 */
export async function listVmOfflineSessions() {
  const { baseUrl, realm } = getKeycloakConfig();
  const { clientId } = getFlotillaVmClientConfig();
  const adminToken = await getAdminToken();
  const uuid = await getClientUuid(clientId, adminToken);

  const pageSize = 500;
  const sessions = [];
  for (let first = 0; ; first += pageSize) {
    const response = await axios.get(
      `${baseUrl}/admin/realms/${realm}/clients/${uuid}/offline-sessions`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
        params: { first, max: pageSize },
        timeout: 10000,
      }
    );
    const page = Array.isArray(response.data) ? response.data : [];
    sessions.push(...page);
    if (page.length < pageSize) break;
  }
  return sessions;
}
