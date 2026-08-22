import 'dotenv/config';
import { StateManager } from './state.js';
import { Watcher } from './watcher.js';

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) {
    console.error('❌ RPC_URL environment variable is missing in .env');
    process.exit(1);
  }

  const confirmations = parseInt(process.env.CONFIRMATIONS || '6', 10);
  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || '15000', 10);
  const startBlockStr = process.env.START_BLOCK;
  const startBlock = startBlockStr ? parseInt(startBlockStr, 10) : undefined;

  const state = new StateManager(startBlock);
  const watcher = new Watcher(rpcUrl, state, confirmations, pollIntervalMs);

  process.on('SIGINT', () => {
    console.log('\nStopping watcher...');
    watcher.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\nStopping watcher...');
    watcher.stop();
    process.exit(0);
  });

  await watcher.start();
}

main().catch(err => {
    console.error('Fatal error startup:', err);
    process.exit(1);
});
