import axios from 'axios';
import { keycloakConfig } from '../config/keycloak.js';

const {
  baseUrl,
  realm,
  adminUser,
  adminPassword,
  clientId,
  clientSecret,
} = keycloakConfig;

/**
 * Get admin access token (short-lived)
 */
export async function getAdminToken() {
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
 * Assign realm role "user" to the user
 */
export async function assignUserRole(userId, adminToken) {
  const roleUrl = `${baseUrl}/admin/realms/${realm}/roles/user`;
  const mappingUrl = `${baseUrl}/admin/realms/${realm}/users/${userId}/role-mappings/realm`;

  const roleRes = await axios.get(roleUrl, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

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
 * Login user using ROPC
 */
export async function loginUser(username, password) {
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
