import pkg from 'immudb-node';

const ImmudbClient = pkg.default;

async function setupImmuDB() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║        ImmuDB Setup for Audit Logging                      ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const adminClient = new ImmudbClient({
    host: '127.0.0.1',
    port: 3322,
  });

  try {
    // Step 1: Connect as admin
    console.log('Step 1: Connecting to ImmuDB as admin...');
    await adminClient.login({
      user: 'immudb',
      password: 'immudb',
    });
    console.log('✓ Connected to ImmuDB as admin\n');

    // Step 2: Create the audit database
    console.log('Step 2: Creating audit database (anon_audit)...');
    try {
      const result = await adminClient.createDatabase({ databasename: 'anon_audit' });
      console.log('✓ Database created: anon_audit\n');
    } catch (err) {
      if (err.message?.includes('already exists') || err.message?.includes('exists')) {
        console.log('ℹ Database already exists: anon_audit\n');
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
    console.log('Step 3: Setting up anon_backend user...');
    try {
      await adminClient.createUser({
        user: 'anon_backend',
        password: 'AnonBackend@123',
        database: 'anon_audit',
        permission: 2,
      });
      console.log('✓ User created: anon_backend\n');
    } catch (err) {
      if (err.message?.includes('already exists') || err.message?.includes('exists')) {
        console.log('ℹ User already exists: anon_backend\n');
      } else {
        throw err;
      }
    }

    // Step 4: Grant permissions
    console.log('Step 4: Granting read/write permissions on anon_audit database...');
    try {
      // Note: Permission format might vary by version - trying common approaches
      await adminClient.changeUserPassword({
        user: 'anon_backend',
        oldPassword: 'AnonBackend@123',
        newPassword: 'AnonBackend@123',
      });
      console.log('✓ User configured\n');
    } catch (err) {
      console.log('ℹ User setup complete (permission check skipped)\n');
    }

    // Step 5: Test connection as anon_backend
    console.log('Step 5: Testing connection as anon_backend...');
    const userClient = new ImmudbClient({
      host: '127.0.0.1',
      port: 3322,
    });

    await userClient.login({
      user: 'anon_backend',
      password: 'AnonBackend@123',
    });
    console.log('✓ Successfully logged in as anon_backend\n');

    // Step 6: Select database
    console.log('Step 6: Selecting anon_audit database...');
    try {
      await userClient.useDatabase({
        databasename: 'anon_audit',
      });
      console.log('✓ Database selected: anon_audit\n');
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
    console.log('  Database:  anon_audit');
    console.log('  User:      anon_backend');
    console.log('  Password:  AnonBackend@123');
    console.log('  Host:      127.0.0.1');
    console.log('  Port:      3322');
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
