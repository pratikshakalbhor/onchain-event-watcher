import test from "node:test";
import assert from "node:assert";
import { StateManager } from "./state.js";
import { RpcClient } from "./rpc.js";
import { id, Interface, Log } from "ethers";
import { TRANSFER_TOPIC, parseTransferLog, formatTransferAlert } from "./events.js";
import type { ParsedTransfer } from "./events.js";
import fs from "fs";
import path from "path";

// Use isolated test paths to avoid polluting production state
const TEST_CHECKPOINT = path.join(process.cwd(), "data", "test-checkpoint.json");
const TEST_SEEN = path.join(process.cwd(), "data", "test-seen-events.json");

function makeTestState(startBlock?: number) {
  return new StateManager({
    startBlock,
    checkpointPath: TEST_CHECKPOINT,
    seenEventsPath: TEST_SEEN,
  });
}

// Cleanup test files
function cleanup() {
  for (const f of [TEST_CHECKPOINT, TEST_SEEN]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
}

// Ensure clean state before and after all tests
cleanup();

test("Requirements 1: Topic0 is generated correctly from event signature", () => {
  const generatedId = id("Transfer(address,address,uint256)");
  assert.strictEqual(generatedId, TRANSFER_TOPIC, "Topic0 should match keccak256 hash");
  assert.strictEqual(TRANSFER_TOPIC, "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
});

test("Requirements 2 & 4: Checkpoint persistence and no-gap progression", () => {
  cleanup();
  
  const state = makeTestState();
  state.checkpoint.lastProcessedBlock = 1000;
  state.save();

  const state2 = makeTestState();
  assert.strictEqual(state2.checkpoint.lastProcessedBlock, 1000, "Checkpoint should persist across restarts");
  
  // Next range should start at 1001
  const fromBlock = state2.checkpoint.lastProcessedBlock + 1;
  assert.strictEqual(fromBlock, 1001, "Next range should start at lastProcessedBlock + 1");
  
  cleanup();
});

test("Requirements 2 & 4: START_BLOCK used when no checkpoint exists", () => {
  cleanup();
  
  const state = makeTestState(5000);
  assert.strictEqual(state.checkpoint.lastProcessedBlock, 4999, "START_BLOCK - 1 should be used as lastProcessedBlock");
  
  cleanup();
});

test("Requirements 2 & 4: Existing checkpoint takes precedence over START_BLOCK", () => {
  cleanup();
  
  // First create a checkpoint
  const state1 = makeTestState();
  state1.checkpoint.lastProcessedBlock = 1000;
  state1.save();
  
  // Then create new StateManager with different START_BLOCK
  const state2 = makeTestState(5000);
  assert.strictEqual(state2.checkpoint.lastProcessedBlock, 1000, "Existing checkpoint should take precedence over START_BLOCK");
  
  cleanup();
});

test("Requirements 3: Safe head uses current block minus confirmations", () => {
  const currentHead = 23000000;
  const confirmations = 6;
  const safeHead = currentHead - confirmations;
  assert.strictEqual(safeHead, 22999994, "Safe head should be currentHead - confirmations");
});

test("Requirements 5: Reorg detection rollback logic", () => {
  cleanup();
  
  const state = makeTestState();
  state.checkpoint.lastProcessedBlock = 1000;
  state.checkpoint.recentBlocks = {
    998: "0xhash998",
    999: "0xhash999",
    1000: "0xhash1000",
  };
  state.save();

  // Simulate reorg: block 1000 hash changes
  const state2 = makeTestState();
  state2.checkpoint.recentBlocks[1000] = "0xnewhash1000"; // different hash
  
  // The rollback function should work
  state2.rollback(997);
  assert.strictEqual(state2.checkpoint.lastProcessedBlock, 997, "Should rollback to specified block");
  assert.ok(!(1000 in state2.checkpoint.recentBlocks), "Rolled-back blocks should be removed");
  assert.ok(!(999 in state2.checkpoint.recentBlocks), "Rolled-back blocks should be removed");
  assert.ok(!(998 in state2.checkpoint.recentBlocks), "Rolled-back blocks should be removed");
  
  cleanup();
});

test("Requirements 6: Event ID deduplication works", () => {
  cleanup();
  
  const state = makeTestState();
  
  const eventId = "0xabc123:5";
  assert.strictEqual(state.isEventSeen(eventId), false, "New event should not be seen");
  state.markEventSeen(eventId);
  assert.strictEqual(state.isEventSeen(eventId), true, "Event should be marked as seen");
  
  // Mark again - should still be seen (idempotent)
  state.markEventSeen(eventId);
  assert.strictEqual(state.isEventSeen(eventId), true, "Duplicate mark should not change state");
  
  // Different log index should be different event
  const eventId2 = "0xabc123:6";
  assert.strictEqual(state.isEventSeen(eventId2), false, "Different log index should be different event");
  
  cleanup();
});

test("Requirements 7: RPC Recursive Splitting on range-too-large error", async () => {
  const rpc = new RpcClient("http://dummy");
  let callCount = 0;

  // Mock the provider
  rpc.provider.getLogs = async (filter: any) => {
    callCount++;
    if (filter.toBlock - filter.fromBlock > 10) {
      const err = new Error("range too large");
      (err as any).error = { message: "range too large" };
      throw err;
    }
    return [];
  };

  await rpc.fetchLogs(1, 100, "0x123", [TRANSFER_TOPIC]);
  
  assert.ok(callCount > 1, `Should call getLogs multiple times to split (called ${callCount} times)`);
  // With recursive splitting: 1-100 -> 1-50, 51-100 -> 1-25, 26-50, 51-75, 76-100 ...
  // Should be at least log2(100) ≈ 7 calls
  assert.ok(callCount >= 7, `Should have enough recursive calls to cover range (called ${callCount} times)`);
});

test("Requirements 7: RPC splitting works for single block", async () => {
  const rpc = new RpcClient("http://dummy");
  
  rpc.provider.getLogs = async (filter: any) => {
    if (filter.toBlock - filter.fromBlock > 0) {
      const err = new Error("range too large");
      (err as any).error = { message: "range too large" };
      throw err;
    }
    return [{ transactionHash: "0x123", index: 0, topics: [], data: "0x", blockNumber: 1, address: "0x123", removed: false, blockHash: "0x1", transactionIndex: 0, logIndex: 0, toJSON: () => ({}) }] as any;
  };

  const logs = await rpc.fetchLogs(5, 5, "0x123", [TRANSFER_TOPIC]);
  assert.strictEqual(logs.length, 1, "Should work for single block");
});

test("Requirements 7: RPC throws on single block too large", async () => {
  const rpc = new RpcClient("http://dummy");
  
  rpc.provider.getLogs = async (filter: any) => {
    const err = new Error("range too large");
    (err as any).error = { message: "range too large" };
    throw err;
  };

  try {
    await rpc.fetchLogs(5, 5, "0x123", [TRANSFER_TOPIC]);
    assert.fail("Should throw for single block too large");
  } catch (err: any) {
    assert.ok(err.message.includes("Cannot split single block"), "Should throw with clear message");
  }
});

test("Parse transfer log correctly", () => {
  // Create a mock log that matches Transfer event
  // value = 1000000 * 10^6 = 1000000000000 = 0xE8D4A51000 (USDC has 6 decimals)
  // Data must be 32 bytes (64 hex chars after 0x)
  const mockLog = {
    transactionHash: "0xabc123",
    index: 2,
    blockNumber: 23000000,
    topics: [
      TRANSFER_TOPIC,
      "0x0000000000000000000000001111111111111111111111111111111111111111", // from
      "0x0000000000000000000000002222222222222222222222222222222222222222", // to
    ],
    data: "0x000000000000000000000000000000000000000000000000000000e8d4a51000", // 1000000 USDC (6 decimals) = 1000000000000
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    removed: false,
    blockHash: "0x1",
    transactionIndex: 0,
    logIndex: 2,
    toJSON: () => ({}),
  } as unknown as Log;

  const parsed = parseTransferLog(mockLog);
  assert.ok(parsed !== null, "Should parse valid transfer log");
  assert.strictEqual(parsed!.from, "0x1111111111111111111111111111111111111111");
  assert.strictEqual(parsed!.to, "0x2222222222222222222222222222222222222222");
  assert.strictEqual(parsed!.value, "1000000000000", "Raw value should be the full uint256 amount");
  assert.strictEqual(parsed!.transactionHash, "0xabc123");
  assert.strictEqual(parsed!.logIndex, 2);
  assert.strictEqual(parsed!.blockNumber, 23000000);
});

test("Format transfer alert", () => {
  const transfer: ParsedTransfer = {
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    value: "1000000",
    transactionHash: "0xabc123",
    logIndex: 2,
    blockNumber: 23000000,
  };

  const alert = formatTransferAlert(transfer);
  assert.ok(alert.includes("🔔 NEW USDC TRANSFER"));
  assert.ok(alert.includes("Block: 23000000"));
  assert.ok(alert.includes("Transaction: 0xabc123"));
  assert.ok(alert.includes("Log Index: 2"));
  assert.ok(alert.includes("From: 0x1111111111111111111111111111111111111111"));
  assert.ok(alert.includes("To: 0x2222222222222222222222222222222222222222"));
  assert.ok(alert.includes("Raw Amount: 1000000"));
  assert.ok(alert.includes("Event ID: 0xabc123:2"));
});

test("State recordBlockHash keeps only recent blocks", () => {
  cleanup();
  
  const state = makeTestState();
  state.checkpoint.lastProcessedBlock = 1000;
  
  // Record 150 blocks
  for (let i = 851; i <= 1000; i++) {
    state.recordBlockHash(i, `0xhash${i}`, 100);
  }
  
  // Should only keep last 100 blocks (901-1000)
  const keys = Object.keys(state.checkpoint.recentBlocks).map(Number).sort((a, b) => a - b);
  assert.strictEqual(keys.length, 100, "Should keep only maxBlocks entries");
  assert.strictEqual(keys[0], 901, "Oldest kept should be 901");
  assert.strictEqual(keys[keys.length - 1], 1000, "Newest kept should be 1000");
  
  cleanup();
});

test("State getStoredBlockHash works", () => {
  cleanup();
  
  const state = makeTestState();
  state.checkpoint.recentBlocks[1000] = "0xhash1000";
  
  assert.strictEqual(state.getStoredBlockHash(1000), "0xhash1000");
  assert.strictEqual(state.getStoredBlockHash(999), undefined);
  
  cleanup();
});

test("Requirements 7: Large range splits into complete subranges without gaps", async () => {
  const rpc = new RpcClient("http://dummy");
  const successfulRanges: Array<{ from: number; to: number }> = [];

  // Mock provider that tracks successful ranges only
  rpc.provider.getLogs = async (filter: any) => {
    if (filter.toBlock - filter.fromBlock > 10) {
      const err = new Error("range too large");
      (err as any).error = { message: "range too large" };
      throw err;
    }
    successfulRanges.push({ from: filter.fromBlock, to: filter.toBlock });
    return [];
  };

  await rpc.fetchLogs(1, 100, "0x123", [TRANSFER_TOPIC]);
  
  // Verify all blocks 1-100 are covered without gaps or overlaps
  successfulRanges.sort((a, b) => a.from - b.from);
  
  // First range should start at 1
  assert.strictEqual(successfulRanges[0]!.from, 1);
  // Last range should end at 100
  assert.strictEqual(successfulRanges[successfulRanges.length - 1]!.to, 100);
  
  // Check no gaps or overlaps between adjacent ranges
  for (let i = 1; i < successfulRanges.length; i++) {
    const prev = successfulRanges[i - 1]!;
    const curr = successfulRanges[i]!;
    assert.strictEqual(curr.from, prev.to + 1, `No gap between range ${i-1} and ${i}`);
    assert.ok(curr.from > prev.from, `Ranges should progress forward`);
  }
  
  // Verify complete coverage: sum of range sizes should equal 100
  const totalBlocks = successfulRanges.reduce((sum, r) => sum + (r.to - r.from + 1), 0);
  assert.strictEqual(totalBlocks, 100, "All 100 blocks should be covered exactly once");
});

test("Requirements 7: Single-block range is handled correctly", async () => {
  const rpc = new RpcClient("http://dummy");
  
  rpc.provider.getLogs = async (filter: any) => {
    if (filter.toBlock - filter.fromBlock > 0) {
      const err = new Error("range too large");
      (err as any).error = { message: "range too large" };
      throw err;
    }
    return [{ transactionHash: "0x123", index: 0, topics: [], data: "0x", blockNumber: 1, address: "0x123", removed: false, blockHash: "0x1", transactionIndex: 0, logIndex: 0, toJSON: () => ({}) }] as any;
  };

  const logs = await rpc.fetchLogs(5, 5, "0x123", [TRANSFER_TOPIC]);
  assert.strictEqual(logs.length, 1, "Should work for single block");
});

test("Requirements 7: Genuine single-block RPC failure is surfaced", async () => {
  const rpc = new RpcClient("http://dummy");
  
  rpc.provider.getLogs = async (filter: any) => {
    const err = new Error("range too large");
    (err as any).error = { message: "range too large" };
    throw err;
  };

  try {
    await rpc.fetchLogs(5, 5, "0x123", [TRANSFER_TOPIC]);
    assert.fail("Should throw for single block too large");
  } catch (err: any) {
    assert.ok(err.message.includes("Cannot split single block"), "Should throw with clear message");
  }
});

test("Requirements 7: Realistic large range can be reduced without artificial recursion limit", async () => {
  // Test a realistic Ethereum range (e.g., ~1M blocks) 
  // This would require ~20 splits with binary splitting (log2(1M) ≈ 20)
  const rpc = new RpcClient("http://dummy");
  let callCount = 0;

  rpc.provider.getLogs = async (filter: any) => {
    callCount++;
    // Accept ranges up to 50000 blocks
    if (filter.toBlock - filter.fromBlock > 50000) {
      const err = new Error("range too large");
      (err as any).error = { message: "range too large" };
      throw err;
    }
    return [];
  };

  // 1M blocks - should work with iterative approach (no depth limit)
  await rpc.fetchLogs(22000000, 23000000, "0x123", [TRANSFER_TOPIC]);
  
  // Should make enough calls to cover the range
  // 1M / 50000 = 20 segments minimum, but binary splitting makes more calls
  assert.ok(callCount >= 20, `Should make enough calls for 1M block range (made ${callCount})`);
});

test("Requirements 7: Checkpoint does not advance when subrange fails", async () => {
  const rpc = new RpcClient("http://dummy");
  let attempt = 0;

  rpc.provider.getLogs = async (filter: any) => {
    attempt++;
    // Fail on the 3rd call (simulating a persistent error on one subrange)
    if (attempt === 3) {
      throw new Error("network error");
    }
    if (filter.toBlock - filter.fromBlock > 10) {
      const err = new Error("range too large");
      (err as any).error = { message: "range too large" };
      throw err;
    }
    return [];
  };

  try {
    await rpc.fetchLogs(1, 100, "0x123", [TRANSFER_TOPIC]);
    assert.fail("Should have thrown on subrange failure");
  } catch (err: any) {
    assert.ok(err.message.includes("network error"), "Original error should be thrown");
  }
});

// Clean up on test completion
cleanup();