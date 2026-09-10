// One-off provisioning script: creates the "fl-orchestrator" Keycloak user
// and its realm role. Run once against a fresh Keycloak (e.g. after a realm
// reset): `node scripts/create-fl-orchestrator-user.js`.
//
// This account is the platform operator who processes the "Start FL Session"
// queue (see /p3dx/gov/queue-fl-session and p3dx-auth-ui's
// FL_Orchestrator page) - logging in with it at p3dx-auth-ui (5174) lands
// on /app/orchestrator instead of the normal dashboard.
import 'dotenv/config';
import { getAdminToken, createUser, getUserId, assignRealmRole } from '../src/services/keycloak.service.js';

const USERNAME = 'fl-orchestrator';
const PASSWORD = 'Florchestrator';
const ROLE = 'fl-orchestrator';

async function main() {
  const adminToken = await getAdminToken();

  try {
    await createUser(
      { username: USERNAME, email: `${USERNAME}@p3dx.local`, firstName: 'FL', lastName: 'Orchestrator', password: PASSWORD },
      adminToken
    );
    console.log(`Created Keycloak user "${USERNAME}".`);
  } catch (err) {
    if (err.response?.status === 409) {
      console.log(`Keycloak user "${USERNAME}" already exists - skipping creation.`);
    } else {
      throw err;
    }
  }

  const userId = await getUserId(USERNAME, adminToken);
  await assignRealmRole(userId, ROLE, adminToken);
  console.log(`Assigned realm role "${ROLE}" to "${USERNAME}".`);
}

main()
  .then(() => {
    console.log('Done.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Failed:', err.response?.data || err.message);
    process.exit(1);
  });
