# Sherlock — Bitcoin Chain Analysis Engine

Sherlock is a Bitcoin chain analysis engine that processes raw block data (`blk.dat`, `rev.dat`, `xor.dat`) and extracts meaningful patterns from transactions using heuristic-based analysis.

It combines:
- Low-level Bitcoin parsing
- Heuristic-based transaction analysis
- Interactive web visualization

The goal is to move beyond raw blockchain data and uncover behavioral patterns such as wallet ownership, transaction intent, and privacy techniques like CoinJoin.


## 🚀 Features

- **Full block parsing pipeline**
  - Parses raw Bitcoin Core data files
  - Reconstructs transactions and prevout data

- **Heuristic engine (6+ heuristics)**
  - Common Input Ownership (CIOH)
  - Change detection
  - CoinJoin detection
  - Consolidation detection
  - Address reuse
  - Round-number payments

- **Transaction classification**
  - simple_payment
  - consolidation
  - coinjoin
  - self_transfer
  - batch_payment

- **Fee analysis**
  - Accurate fee and vsize calculation (BIP141)
  - Distribution stats (min, max, median, mean)

- **Web visualizer**
  - Interactive transaction exploration
  - Heuristic filtering
  - Block-level analytics dashboard

- **Markdown reporting**
  - Auto-generated human-readable reports per block file


## 🧠 What this project demonstrates

This project shows:

- Deep understanding of Bitcoin’s UTXO model  
- Ability to parse and reconstruct blockchain data without external APIs  
- Practical application of chain analysis heuristics  
- Building end-to-end systems (CLI + backend + UI)  


## 📊 Example Insights

From real block data, Sherlock can:

- Link multiple inputs to a single entity (CIOH)
- Identify which output is likely "change"
- Detect CoinJoin transactions used for privacy
- Spot wallet consolidation patterns
- Analyze fee market behavior


## ⚙️ Architecture

1. Parse raw block + undo data
2. Reconstruct transaction graph
3. Apply heuristics per transaction
4. Aggregate block-level statistics
5. Output JSON + Markdown + Web UI


## 🛠️ Usage

```bash
./setup.sh
./cli.sh --block blk04330.dat rev04330.dat xor.dat
./web.sh