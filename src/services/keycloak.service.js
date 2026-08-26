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
