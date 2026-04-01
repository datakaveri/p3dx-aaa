import 'dotenv/config';
import app from './app.js';
import { initImmuDB } from './services/immudb.service.js';

const PORT = process.env.PORT || 3000;

async function start() {
  try {
    await initImmuDB();

    app.listen(PORT, () => {
      console.log(`p3dx-aaa auth backend running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
}

start().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
