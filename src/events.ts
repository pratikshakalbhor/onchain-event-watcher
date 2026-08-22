import { id, Interface, Log } from "ethers";

export const USDC_CONTRACT =
  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

export const TRANSFER_EVENT =
  "Transfer(address,address,uint256)";

// topic0 = keccak256("Transfer(address,address,uint256)")
export const TRANSFER_TOPIC = id(TRANSFER_EVENT);

const transferInterface = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export interface ParsedTransfer {
  from: string;
  to: string;
  value: string;
  transactionHash: string;
  logIndex: number;
  blockNumber: number;
}

export function parseTransferLog(log: Log): ParsedTransfer | null {
  try {
    const parsed = transferInterface.parseLog({
      topics: [...log.topics],
      data: log.data,
    });

    if (!parsed) {
      return null;
    }

    return {
      from: parsed.args[0],
      to: parsed.args[1],
      value: parsed.args[2].toString(),
      transactionHash: log.transactionHash,
      logIndex: log.index,
      blockNumber: log.blockNumber,
    };
  } catch {
    return null;
  }
}

export function formatUsdcAmount(value: string | bigint): string {
  const bigVal = BigInt(value);
  if (bigVal === 0n) {
    return "0 USDC";
  }
  const decimals = 6n;
  const scale = 10n ** decimals;
  const integerPart = bigVal / scale;
  const remainder = bigVal % scale;

  if (remainder === 0n) {
    return `${integerPart} USDC`;
  }

  const fracStr = remainder.toString().padStart(6, "0").replace(/0+$/, "");
  return `${integerPart}.${fracStr} USDC`;
}

export function formatTransferAlert(transfer: ParsedTransfer): string {
  return [
    "\n🔔 NEW USDC TRANSFER",
    `Block: ${transfer.blockNumber}`,
    `Transaction: ${transfer.transactionHash}`,
    `Log Index: ${transfer.logIndex}`,
    `From: ${transfer.from}`,
    `To: ${transfer.to}`,
    `Raw Amount: ${transfer.value}`,
    `Amount: ${formatUsdcAmount(transfer.value)}`,
    `Event ID: ${transfer.transactionHash}:${transfer.logIndex}\n`,
  ].join("\n");
}

