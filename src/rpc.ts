import { JsonRpcProvider, Log, Block, Filter } from "ethers";

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
    return this.fetchLogsWithRetry(fromBlock, toBlock, address, topics, 0);
  }

  private async fetchLogsWithRetry(
    fromBlock: number,
    toBlock: number,
    address: string,
    topics: (string | null)[],
    depth: number
  ): Promise<Log[]> {
    if (depth > 20) {
      throw new Error(`Maximum recursion depth exceeded for range ${fromBlock} → ${toBlock}`);
    }

    const filter: Filter = {
      fromBlock,
      toBlock,
      address,
      topics,
    };

    try {
      return await this.provider.getLogs(filter);
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
        if (fromBlock === toBlock) {
          throw new Error(
            `Cannot split single block ${fromBlock}. RPC error: ${err.message}`
          );
        }
        console.log(
          `⚠️ RPC range too large\nSplitting range ${fromBlock} → ${toBlock} ...`
        );

        const midpoint = Math.floor((fromBlock + toBlock) / 2);
        const leftLogs = await this.fetchLogsWithRetry(
          fromBlock,
          midpoint,
          address,
          topics,
          depth + 1
        );
        const rightLogs = await this.fetchLogsWithRetry(
          midpoint + 1,
          toBlock,
          address,
          topics,
          depth + 1
        );

        return [...leftLogs, ...rightLogs];
      }
      throw err;
    }
  }
}
