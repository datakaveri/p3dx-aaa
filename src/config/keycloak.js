export const keycloakConfig = {
  baseUrl: process.env.KEYCLOAK_BASE_URL,
  realm: process.env.KEYCLOAK_REALM,
  adminUser: process.env.KEYCLOAK_ADMIN_USER,
  adminPassword: process.env.KEYCLOAK_ADMIN_PASSWORD,
  clientId: process.env.KEYCLOAK_CLIENT_ID,
  clientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
};
