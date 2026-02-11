import pkg from 'immudb-node';

const ImmudbClient = pkg.default;

async function diagnose() {
  console.log('\n🔍 ImmuDB Diagnostic Check\n');

  const credentials = [
    { user: 'immudb', password: 'immudb' },
    { user: 'immudb', password: '' },
    { user: 'anon_backend', password: 'AnonBackend@123' },
  ];

  for (const cred of credentials) {
    try {
      const client = new ImmudbClient({
        host: '127.0.0.1',
        port: 3322,
      });

      console.log(`Trying: ${cred.user} / ${cred.password || '(empty)'}`);
      
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

  console.log('🔍 Diagnostic complete\n');
}

diagnose();
