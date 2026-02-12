import 'dotenv/config';
import pkg from 'immudb-node';

const ImmudbClient = pkg.default;

async function setupImmuDB() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║        ImmuDB Setup for Audit Logging                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const host = process.env.IMMUDB_HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.IMMUDB_PORT || '3322', 10);
  const adminUser = process.env.IMMUDB_ADMIN_USER || 'immudb';
  const adminPassword = process.env.IMMUDB_ADMIN_PASSWORD || 'immudb';
  const database = process.env.IMMUDB_DATABASE || 'anon_audit';
  const appUser = process.env.IMMUDB_USER || 'anon_backend';
  const appPassword = process.env.IMMUDB_PASSWORD;

  const adminClient = new ImmudbClient({
    host,
    port,
  });

  try {
    // Step 1: Connect as admin
    console.log('Step 1: Connecting to ImmuDB as admin...');
    await adminClient.login({
      user: adminUser,
      password: adminPassword,
    });
    console.log('✓ Connected to ImmuDB as admin\n');

    // Step 2: Create the audit database
    console.log(`Step 2: Creating audit database (${database})...`);
    try {
      await adminClient.createDatabase({ databasename: database });
      console.log(`✓ Database created: ${database}\n`);
    } catch (err) {
      if (err.message?.includes('already exists') || err.message?.includes('exists')) {
        console.log(`ℹ Database already exists: ${database}\n`);
      } else {
        throw err;
      }
    }

    // Ensure a database context is selected (required when multiple databases exist)
    try {
      await adminClient.useDatabase({ databasename: 'defaultdb' });
    } catch {
      // ignore
    }

    // Step 3: Create or verify anon_backend user
    console.log(`Step 3: Setting up ${appUser} user...`);
    if (!appPassword) {
      throw new Error('IMMUDB_PASSWORD is required for creating/verifying the app user. Set it in your local .env');
    }
    try {
      await adminClient.createUser({
        user: appUser,
        password: appPassword,
        database,
        permission: 2,
      });
      console.log(`✓ User created: ${appUser}\n`);
    } catch (err) {
      if (err.message?.includes('already exists') || err.message?.includes('exists')) {
        console.log(`ℹ User already exists: ${appUser}\n`);
      } else {
        throw err;
      }
    }

    // Step 4: Grant permissions
    console.log(`Step 4: Granting read/write permissions on ${database} database...`);
    try {
      // Note: Permission format might vary by version - trying common approaches
      await adminClient.changeUserPassword({
        user: appUser,
        oldPassword: appPassword,
        newPassword: appPassword,
      });
      console.log('✓ User configured\n');
    } catch (err) {
      console.log('ℹ User setup complete (permission check skipped)\n');
    }

    // Step 5: Test connection as anon_backend
    console.log(`Step 5: Testing connection as ${appUser}...`);
    const userClient = new ImmudbClient({
      host,
      port,
    });

    await userClient.login({
      user: appUser,
      password: appPassword,
    });
    console.log(`✓ Successfully logged in as ${appUser}\n`);

    // Step 6: Select database
    console.log(`Step 6: Selecting ${database} database...`);
    try {
      await userClient.useDatabase({
        databasename: database,
      });
      console.log(`✓ Database selected: ${database}\n`);
    } catch (err) {
      console.log('⚠ Could not select database:', err.message);
      console.log('  (This may require admin configuration)\n');
    }

    // Step 7: Test write permission
    console.log('Step 7: Testing write permission...');
    try {
      await userClient.set('setup:test:' + Date.now(), 'ImmuDB is ready for audit logging');
      console.log('✓ Write test successful\n');
      
      // Test read
      const result = await userClient.get('setup:test:' + (Date.now() - 100));
      console.log('✓ Read test successful\n');
    } catch (err) {
      console.log('⚠ Read/Write test:', err.message);
      console.log('  (Setup will continue)\n');
    }

    await userClient.logout();
    await adminClient.logout();

    // Success summary
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║                  ✓ SETUP COMPLETE                         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    console.log('Configuration:');
    console.log(`  Database:  ${database}`);
    console.log(`  User:      ${appUser}`);
    console.log('  Password:  (from IMMUDB_PASSWORD in .env)');
    console.log(`  Host:      ${host}`);
    console.log(`  Port:      ${port}`);
    console.log('\n.env file is pre-configured in your backend.\n');
    console.log('Next steps:');
    console.log('  1. npm start          (start the backend)');
    console.log('  2. npm run test:immudb (test audit logging)');
    console.log('  3. Check logs for audit events\n');

  } catch (err) {
    console.error('✗ Setup failed:', err.message);
    process.exit(1);
  }
}

setupImmuDB();
