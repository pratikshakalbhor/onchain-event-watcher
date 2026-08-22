import fs from "fs";
import path from "path";

export const CHECKPOINT_PATH = path.join(process.cwd(), "data", "checkpoint.json");
export const SEEN_EVENTS_PATH = path.join(process.cwd(), "data", "seen-events.json");

export interface Checkpoint {
  lastProcessedBlock: number;
  recentBlocks: { [blockNumber: number]: string };
}

export interface StateManagerOptions {
  startBlock?: number | undefined;
  checkpointPath?: string | undefined;
  seenEventsPath?: string | undefined;
}

export class StateManager {
  checkpoint: Checkpoint = { lastProcessedBlock: 0, recentBlocks: {} };
  seenEvents: Set<string> = new Set();
  private checkpointPath: string;
  private seenEventsPath: string;

  constructor(options: StateManagerOptions = {}) {
    this.checkpointPath = options.checkpointPath || CHECKPOINT_PATH;
    this.seenEventsPath = options.seenEventsPath || SEEN_EVENTS_PATH;
    
    const dataDir = path.dirname(this.checkpointPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    this.load(options.startBlock);
  }

  load(startBlock?: number) {
    let hasCheckpoint = false;

    if (fs.existsSync(this.checkpointPath)) {
      try {
        const data = fs.readFileSync(this.checkpointPath, "utf-8");
        this.checkpoint = JSON.parse(data);
        hasCheckpoint = true;
      } catch (e) {
        console.warn("Could not parse checkpoint, starting fresh.");
      }
    }

    // Only use startBlock if no checkpoint exists
    if (!hasCheckpoint && startBlock !== undefined) {
      this.checkpoint.lastProcessedBlock = startBlock - 1;
    }

    if (fs.existsSync(this.seenEventsPath)) {
      try {
        const data = fs.readFileSync(this.seenEventsPath, "utf-8");
        const list = JSON.parse(data);
        if (Array.isArray(list)) {
          this.seenEvents = new Set(list);
        }
      } catch (e) {
        console.warn("Could not parse seen-events, starting empty.");
      }
    }
  }

  save() {
    const tmpCheckpoint = this.checkpointPath + ".tmp";
    fs.writeFileSync(tmpCheckpoint, JSON.stringify(this.checkpoint, null, 2), "utf-8");
    fs.renameSync(tmpCheckpoint, this.checkpointPath);

    const tmpSeen = this.seenEventsPath + ".tmp";
    fs.writeFileSync(tmpSeen, JSON.stringify(Array.from(this.seenEvents), null, 2), "utf-8");
    fs.renameSync(tmpSeen, this.seenEventsPath);
  }

  /**
   * Rollback checkpoint to a specific block.
   * Removes all recentBlocks entries > toBlock.
   * Does NOT remove seen events (they are globally unique by txHash:logIndex).
   */
  rollback(toBlock: number) {
    this.checkpoint.lastProcessedBlock = toBlock;
    for (const b in this.checkpoint.recentBlocks) {
      if (Number(b) > toBlock) {
        delete this.checkpoint.recentBlocks[b];
      }
    }
    this.save();
  }

  isEventSeen(eventId: string): boolean {
    return this.seenEvents.has(eventId);
  }

  markEventSeen(eventId: string) {
    this.seenEvents.add(eventId);
  }

  /**
   * Record the hash of a processed block for reorg detection.
   * Keeps only the most recent N block hashes.
   */
  recordBlockHash(blockNumber: number, blockHash: string, maxBlocks: number = 100) {
    if (!this.checkpoint.recentBlocks) {
      this.checkpoint.recentBlocks = {};
    }
    this.checkpoint.recentBlocks[blockNumber] = blockHash;

    // Keep only the most recent maxBlocks entries
    const keys = Object.keys(this.checkpoint.recentBlocks)
      .map(Number)
      .sort((a, b) => b - a);
    if (keys.length > maxBlocks) {
      for (const key of keys.slice(maxBlocks)) {
        delete this.checkpoint.recentBlocks[key];
      }
    }
  }

  /**
   * Get stored block hash for reorg verification.
   */
  getStoredBlockHash(blockNumber: number): string | undefined {
    return this.checkpoint.recentBlocks[blockNumber];
  }
}
