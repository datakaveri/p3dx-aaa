import 'dotenv/config';
import pkg from 'immudb-node';

const ImmudbClient = pkg.default;

async function diagnose() {
  console.log('\nImmuDB Diagnostic Check\n');

  const host = process.env.IMMUDB_HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.IMMUDB_PORT || '3322', 10);
  const appUser = process.env.IMMUDB_USER || 'anon_backend';
  const appPassword = process.env.IMMUDB_PASSWORD;

  const credentials = [
    { user: 'immudb', password: 'immudb' },
    { user: 'immudb', password: '' },
    ...(appPassword ? [{ user: appUser, password: appPassword }] : []),
  ];

  for (const cred of credentials) {
    try {
      const client = new ImmudbClient({
        host,
        port,
      });

      console.log(`Trying: ${cred.user} / ${cred.password ? '********' : '(empty)'}`);
      
      await client.login({
        user: cred.user,
        password: cred.password,
      });

      console.log(`✓ SUCCESS with ${cred.user}!`);
      
      // Try to list databases
      try {
        const health = await client.currentDatabase();
        console.log(`  Current database: ${health}`);
      } catch (err) {
        console.log(`  Could not get current database`);
      }

      // Try to use anon_audit
      try {
        await client.useDatabase({ databasename: 'anon_audit' });
        console.log(`  ✓ Can use anon_audit database`);
        
        // Try a simple write
        await client.set({ key: 'test_' + Date.now(), value: 'test value' });
        console.log(`  ✓ Can write to database`);
      } catch (err) {
        console.log(`  ✗ Cannot use anon_audit: ${err.message}`);
      }

      await client.logout();
      console.log();
      
    } catch (err) {
      console.log(`✗ FAILED with ${cred.user}: ${err.message}\n`);
    }
  }

  console.log('Diagnostic complete\n');
}

diagnose();
