import { RpcClient } from "./rpc.js";
import { StateManager } from "./state.js";
import {
  USDC_CONTRACT,
  TRANSFER_TOPIC,
  parseTransferLog,
  formatTransferAlert,
} from "./events.js";

export class Watcher {
  private rpc: RpcClient;
  private state: StateManager;
  private confirmations: number;
  private pollIntervalMs: number;
  private isRunning: boolean = false;

  constructor(
    rpcUrl: string,
    state: StateManager,
    confirmations: number = 6,
    pollIntervalMs: number = 15000
  ) {
    this.rpc = new RpcClient(rpcUrl);
    this.state = state;
    this.confirmations = confirmations;
    this.pollIntervalMs = pollIntervalMs;
  }

  public stop() {
    this.isRunning = false;
  }

  public async start() {
    this.isRunning = true;
    console.log("\n🚀 Onchain Event Watcher\n");
    console.log("Network: Ethereum Mainnet");
    console.log(`Contract: ${USDC_CONTRACT}`);
    console.log("Event: Transfer(address,address,uint256)");
    console.log(`Topic0: ${TRANSFER_TOPIC}`);
    console.log(`Confirmations: ${this.confirmations}`);
    console.log(`Poll interval: ${this.pollIntervalMs}ms`);
    console.log(
      `Starting from block: ${this.state.checkpoint.lastProcessedBlock}\n`
    );

    while (this.isRunning) {
      try {
        await this.poll();
      } catch (err: any) {
        console.error("\n❌ Error during polling:", err.message);
      }

      if (this.isRunning) {
        await this.delay(this.pollIntervalMs);
      }
    }
  }

  async poll() {
    let currentHead: number;
    try {
      currentHead = await this.rpc.getBlockNumber();
    } catch (err) {
      console.error(
        "Failed to fetch chain head:",
        err instanceof Error ? err.message : err
      );
      return;
    }

    const safeHead = currentHead - this.confirmations;
    let lastProcessed = this.state.checkpoint.lastProcessedBlock ?? 0;

    // If this is the first run and we have no checkpoint, start from safeHead - 1
    // (so next poll starts at safeHead)
    if (lastProcessed === 0 && this.state.checkpoint.lastProcessedBlock === 0) {
      lastProcessed = Math.max(0, safeHead - 1);
      this.state.checkpoint.lastProcessedBlock = lastProcessed;
      this.state.save();
    }

    if (safeHead <= lastProcessed) {
      return;
    }

    // --- REORG DETECTION ---
    // Check stored block hashes for the most recent N blocks (up to lastProcessed)
    // We only check blocks we've actually processed (<= lastProcessed)
    const recentBlockNums = Object.keys(this.state.checkpoint.recentBlocks || {})
      .map(Number)
      .filter((b) => b <= lastProcessed)
      .sort((a, b) => b - a); // descending: newest first

    let reorgDetected = false;
    let rollbackBlock = -1;

    for (const bNum of recentBlockNums) {
      try {
        const block = await this.rpc.getBlock(bNum);
        if (!block) continue;

        const storedHash = this.state.checkpoint.recentBlocks[bNum];
        if (block.hash !== storedHash) {
          reorgDetected = true;
        } else if (reorgDetected && rollbackBlock === -1) {
          // We found the first matching hash after a mismatch - rollback to this block
          rollbackBlock = bNum;
          break;
        }
      } catch (e) {
        // Transient RPC failure - skip this block check
        console.warn(
          `Warning: Failed to fetch block ${bNum} for reorg check:`,
          e instanceof Error ? e.message : e
        );
      }
    }

    if (reorgDetected) {
      if (rollbackBlock === -1) {
        // All checked blocks mismatched - rollback to before the oldest checked block
        rollbackBlock = Math.max(
          0,
          recentBlockNums.length > 0
            ? recentBlockNums[recentBlockNums.length - 1] - 1
            : lastProcessed - 100
        );
      }
      console.warn(
        `\n⚠️ REORG DETECTED\nRolling checkpoint back to block ${rollbackBlock}`
      );
      this.state.rollback(rollbackBlock);
      return;
    }

    // --- FETCH LOGS IN RANGE ---
    const fromBlock = lastProcessed + 1;
    const toBlock = safeHead;

    console.log(`🔎 Polling blocks ${fromBlock} → ${toBlock}`);

    let logs: any[];
    try {
      logs = await this.rpc.fetchLogs(
        fromBlock,
        toBlock,
        USDC_CONTRACT,
        [TRANSFER_TOPIC]
      );
    } catch (err: any) {
      console.error(`❌ Failed to fetch logs:`, err.message);
      // Don't advance checkpoint on RPC failure
      throw err;
    }

    let logsFound = false;
    // --- PREVENT DUPLICATES ---
    for (const log of logs) {
      const parsed = parseTransferLog(log);
      if (!parsed) continue;

      const eventId = `${parsed.transactionHash}:${parsed.logIndex}`;
      if (this.state.isEventSeen(eventId)) {
        continue;
      }

      logsFound = true;
      this.state.markEventSeen(eventId);

      console.log(formatTransferAlert(parsed));
    }

    if (!logsFound) {
      console.log(`✓ No matching events`);
    }

    // --- STATE RECORDING ---
    // Record the hash of the highest block we just processed (toBlock)
    try {
      const topBlock = await this.rpc.getBlock(toBlock);
      if (topBlock && topBlock.hash) {
        this.state.recordBlockHash(toBlock, topBlock.hash);
      }
    } catch (e) {
      console.warn(
        `Warning: Failed to fetch block ${toBlock} hash for reorg tracking:`,
        e instanceof Error ? e.message : e
      );
    }

    // Update checkpoint - only advance after successful processing
    this.state.checkpoint.lastProcessedBlock = toBlock;
    this.state.save();
  }

  private delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}