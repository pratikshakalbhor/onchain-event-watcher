# Onchain Event Watcher 🚀 (Road to Devcon)

A reliable, reorg-safe CLI watcher designed for the "Road To Devcon - I Ethereum build challenge", Problem 3: *The Alert That Fired Twice (Or Never)*. 

It monitors Ethereum Mainnet specifically listening to the USDC token `Transfer` events while avoiding missed, duplicated, or invalid alerts.

## 🏗️ Architecture

- **`src/events.ts`**: Holds parsing logic, contract addresses, and constructs the safe `topic0` filter using `ethers.id()`.
- **`src/rpc.ts`**: An RPC client wrapper that safely fetches logs and recursively chunks limits when `eth_getLogs` refuses queries that are too large.
- **`src/state.ts`**: Manages the persistence of `lastProcessedBlock`, hashes for reorg handling, and the seen-event mapping to avoid alert duplicates.
- **`src/watcher.ts`**: The core event loop that computes safe bounds from confirmations, detects reorgs using stored block hashes, triggers logs fetches, dedupes events, and prints alerts.
- **`src/index.ts`**: The CLI entrypoint validating configs handling iterations and graceful shutdowns.

## 🚀 Setup & Execution

### 1. Requirements
Ensure you have `Node.js` (v18+) and `npm` installed.

### 2. Installations
```bash
npm install
```

### 3. Environment Variables
Copy `.env.example` to `.env` and fill it in:
```bash
cp .env.example .env
```
Inside `.env`, provide:
```env
ALCHEMY_API_KEY=your_alchemy_api_key_here
RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your_alchemy_api_key_here
CONFIRMATIONS=6
POLL_INTERVAL_MS=15000
# Optional:
START_BLOCK=20500000
```
*(No real API keys are committed to Git as `.env` is `.gitignore`d.)*

### 4. Running the Watcher
To run the watcher continuously:
```bash
npm start
```

### 5. Running Tests
Tests are executed using `node:test`:
```bash
npm test
```

## 🧠 Core Challenge Mechanisms

### Checkpoint Persistence (Requirement #2, #4)
Instead of keeping the state merely in memory, this watcher natively persists its block heights in `data/checkpoint.json` using atomic disk writes. If you kill the server mid-processing, the next run reliably spins up immediately from exactly `lastProcessedBlock + 1`, keeping the process gap-free without overlapped processing.

### Safe Confirmations Depth (Requirement #3)
We never look up the immediate HEAD. The safe bound is deduced explicitly via: `safeHead = currentHead - CONFIRMATIONS`. This delays polling safely avoiding unconfirmed transaction volatility.

### Reorg Safety Strategy (Requirement #5)
When iterating blocks, we actively cache the most recently requested block hashes in `checkpoint.json`. On subsequent polls, the watcher actively verifies those previously-canonical hashes against the chain's current state. If a mismatch is detected (meaning a reorg displaced previously processed transactions), the application gracefully calculates the divergence block, rolls the checkpoint backward, and reprocesses the corrected timeline.

### Event Duplication Prevention (Requirement #6)
Each log parses into a strict `txHash:logIndex` composite identifier. These IDs are stored persistently inside `data/seen-events.json`. Even through manual reprobing, complex restarts, or triggered reorg rollbacks, the watcher will definitively and silently drop duplicate matching fingerprints, guaranteeing users receive strictly *one* alert per absolute event.

### Handling Large RPC Ranges (Requirement #7)
Ethereum nodes (`eth_getLogs`) frequently reject gigantic ranges, e.g., >10K logs or processing-heavy searches. Our RPC engine catches `range too large`, `log response size exceeded`, and limits error variants specifically. Before crashing, it dynamically bisects `[fromBlock, toBlock]` recursively, querying the left boundary and right boundary in isolated segments, automatically conquering unlimited block timelines cleanly.

