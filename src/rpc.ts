import { JsonRpcProvider, Log, Block } from "ethers";

export class RpcClient {
  public provider: JsonRpcProvider;

  constructor(rpcUrl: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
  }

  async getBlockNumber(): Promise<number> {
    return await this.provider.getBlockNumber();
  }

  async getBlock(blockNumber: number): Promise<Block | null> {
    return await this.provider.getBlock(blockNumber);
  }

  async fetchLogs(
    fromBlock: number,
    toBlock: number,
    address: string,
    topics: (string | null)[]
  ): Promise<Log[]> {
    return this.fetchLogsIterative(fromBlock, toBlock, address, topics);
  }

  /**
   * Iterative range splitting to avoid recursion depth limits.
   * Uses a work queue to process ranges, splitting on "range too large" errors.
   */
  private async fetchLogsIterative(
    fromBlock: number,
    toBlock: number,
    address: string,
    topics: (string | null)[]
  ): Promise<Log[]> {
    // Queue of ranges to process: { fromBlock, toBlock }
    const queue: Array<{ fromBlock: number; toBlock: number }> = [
      { fromBlock, toBlock },
    ];
    const results: Log[] = [];

    while (queue.length > 0) {
      const range = queue.shift()!;
      const { fromBlock: f, toBlock: t } = range;

      const filter = {
        fromBlock: f,
        toBlock: t,
        address,
        topics,
      };

      try {
        const logs = await this.provider.getLogs(filter);
        results.push(...logs);
      } catch (err: any) {
        const errMsg = (err.message || err.toString() || "").toLowerCase();
        const ethError = err.error && err.error.message ? err.error.message.toLowerCase() : "";

        const isRangeTooLarge =
          errMsg.includes("range") ||
          errMsg.includes("limit") ||
          errMsg.includes("too large") ||
          errMsg.includes("10k") ||
          errMsg.includes("response size") ||
          ethError.includes("too large") ||
          ethError.includes("limit") ||
          ethError.includes("range");

        if (isRangeTooLarge) {
          if (f === t) {
            throw new Error(
              `Cannot split single block ${f}. RPC error: ${err.message}`
            );
          }
          console.log(
            `⚠️ RPC range too large\nSplitting range ${f} → ${t} ...`
          );

          // Split at midpoint and push both halves to queue (left first for order)
          const midpoint = Math.floor((f + t) / 2);
          // Push right first, then left, so left is processed first (queue is FIFO)
          queue.unshift({ fromBlock: midpoint + 1, toBlock: t });
          queue.unshift({ fromBlock: f, toBlock: midpoint });
        } else {
          throw err;
        }
      }
    }

    // Sort results by block number then log index to maintain canonical order
    results.sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber - b.blockNumber;
      }
      return a.index - b.index;
    });

    return results;
  }
}
