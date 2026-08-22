import test from 'node:test';
import assert from 'node:assert';
import { StateManager } from './state.js';
import { RpcClient } from './rpc.js';
import { id } from 'ethers';
import { TRANSFER_TOPIC } from './events.js';
import fs from 'fs';

test('Requirements 1: Topic0 is generated correctly', () => {
  const generatedId = id("Transfer(address,address,uint256)");
  assert.strictEqual(generatedId, TRANSFER_TOPIC, 'Topic0 should match keccak256 hash');
});

test('Requirements 2 & 4 & 6: Deduplication and State', () => {
  const state = new StateManager();
  
  state.checkpoint.lastProcessedBlock = 0;
  
  assert.strictEqual(state.isEventSeen('0x123:1'), false);
  state.markEventSeen('0x123:1');
  assert.strictEqual(state.isEventSeen('0x123:1'), true);
});

test('Requirements 7: RPC Recursive Splitting', async () => {
   const rpc = new RpcClient('http://dummy');
   let callCount = 0;

   // Mock the provider
   rpc.provider.getLogs = async (filter: any) => {
     callCount++;
     if (filter.toBlock - filter.fromBlock > 10) {
         throw new Error("range too large");
     }
     return [];
   };
   
   await rpc.fetchLogs(1, 100, "0x123", [TRANSFER_TOPIC]);
   
   assert.ok(callCount > 1, 'Should call getLogs multiple times to split');
});
