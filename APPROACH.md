# APPROACH.md — Sherlock Chain-Analysis Engine

## Architecture Overview

The engine is a pure Node.js pipeline with no external node/RPC dependencies.
All data is read directly from the raw Bitcoin data-directory files bundled in
`fixtures/`.

```
fixtures/blk*.dat.gz  ──┐
fixtures/rev*.dat.gz  ──┤  setup.sh (decompress)
fixtures/xor.dat.gz   ──┘
        │
        ▼
 blockParser.js        XOR-obfuscation removal → raw block envelopes
        │
 transactionParser.js  Deserialise tx fields (txid, vin, vout, segwit)
        │
 revParser.js          Resolve prevout values & scripts from undo data
        │
 heuristicEngine.js    Plugin runner — executes all six heuristics
        │
 classifier.js         Priority decision-tree → single label per tx
        │
 jsonReport.js         out/<stem>.json  (machine-readable schema)
 markdownReport.js     out/<stem>.md    (human-readable tables)
        │
 web/server.js         REST API + static-file server for the web UI
 web/app/              React + Vite single-page visualiser
```

### Module responsibilities

| Layer | Module | Role |
|---|---|---|
| Parser | `blockParser.js` | Read `blk*.dat`, strip XOR mask, extract raw block bytes |
| Parser | `transactionParser.js` | Decode every field from the Bitcoin transaction wire format |
| Parser | `revParser.js` | Read `rev*.dat` undo records to resolve input prevouts |
| Analysis | `feeCalculator.js` | Compute per-transaction fee rates (sat/vB) |
| Analysis | `scriptTypes.js` | Detect output script family from `scriptPubKey` bytes |
| Analysis | `heuristicEngine.js` | Run all registered heuristics, return a result map |
| Analysis | `classifier.js` | Map heuristic results to a classification label |
| Reports | `jsonReport.js` | Emit the Sherlock-schema JSON report |
| Reports | `markdownReport.js` | Emit a human-readable Markdown summary |
| Web | `web/server.js` | Express-free HTTP server; serves API + built React assets |
| Web | `web/app/` | React + Vite SPA (block statistics, tx list, heuristic explorer) |

---

## Heuristics Implemented

Six heuristics are registered with the engine, covering every mandatory and
optional category defined by the challenge.

### 1. Common Input Ownership Heuristic (CIOH)

> `src/heuristics/cioh.js` · id: `cioh`

**What it detects:**
When a transaction spends more than one UTXO, this heuristic assumes all those
UTXOs are controlled by the same wallet — the foundational clustering signal
first described in Satoshi's whitepaper (§10 "Privacy").

**How it is detected/computed:**
Triggered when `input_count ≥ 2` and the transaction is not a coinbase
(identified by a null-hash prev-txid + vout `0xFFFFFFFF`).  No prevout data is
required.

**Confidence model:**
Confidence decays exponentially as more inputs are added, because high-input
transactions are increasingly likely to be CoinJoins or batches rather than
single-owner spends:

```
confidence = 0.9 × exp(−0.12 × (input_count − 2))
```

| Inputs | Confidence |
|--------|-----------|
| 2      | ≈ 0.90    |
| 5      | ≈ 0.63    |
| 10     | ≈ 0.35    |
| 20     | ≈ 0.12    |

**Limitations:**
False positive for CoinJoin and PAYJOIN transactions, which also have multiple
inputs but from independent signers.  The coinjoin heuristic and classifier
priority order mitigate this at the labelling stage.

---

### 2. Change Detection

> `src/heuristics/changeDetection.js` · id: `change_detection`

**What it detects:**
Identifies which output is the "change" returning unspent value to the sender —
a key input to wallet clustering and payment graph construction.

**How it is detected/computed:**
Three independent signals are evaluated simultaneously for every candidate
output.  The index with the highest aggregate score is the likely change:

1. **Script-type match** — change usually returns to the same script family as
   the inputs (e.g. a P2WPKH wallet sends change to a P2WPKH address).
2. **Value comparison** — in a two-output transaction the smaller output is
   more often the change.
3. **Round-number exclusion** — the non-round output is more likely change
   (the payment tends to be the round human-entered amount).

OP_RETURN outputs are excluded from candidacy.  Coinbase transactions are
skipped immediately.

**Confidence model:**
Each signal awards weighted points to its preferred output index:

| Signal              | Weight |
|---------------------|--------|
| Script-type match   | 1.0    |
| Smaller value       | 0.5    |
| Non-round value     | 1.0    |

`confidence = winner_score / 2.5`, clamped to `[0, 1]`.
If all outputs tie, `detected = false` and confidence is 0.

**Limitations:**
Designed for two-output transactions.  With three or more outputs confidence
degrades because multiple candidates compete.  Requires prevout scripts for the
script-type match signal (falls back to value/round signals only when absent).

---

### 3. CoinJoin Detection

> `src/heuristics/coinjoin.js` · id: `coinjoin`

**What it detects:**
Collaborative mixing transactions where multiple independent parties combine
inputs to produce a set of equal-value outputs, breaking the input-to-output
link.

**How it is detected/computed:**
Implements the Möser / Wasabi heuristic: flagged when ALL of the following hold:
- `input_count ≥ 2` (collaborative spend)
- `equal-value output count ≥ 2` (mixed denomination outputs)
- shared denomination `≥ 10 000 sat` (excludes dust coincidences)

**Confidence model:**
Binary (`detected: true/false`).  The equal-output criterion is an objective
structural test, so no fractional score is produced.  Additional metadata
(`equal_output_count`, `denomination_sats`) is returned for display purposes.

**Limitations:**
Necessary but not sufficient: a payment that happens to produce two equal
outputs will be falsely flagged.  Real-world tooling additionally examines
witness structure and address derivation paths, which are beyond local-file
scope.

---

### 4. Consolidation Detection

> `src/heuristics/consolidation.js` · id: `consolidation`

**What it detects:**
Sweep transactions where a wallet merges many UTXOs into one, typically
performed during low-fee periods to reduce future transaction costs.

**How it is detected/computed:**
Triggered when `input_count / output_count ≥ 3.0` AND `input_count ≥ 3`.
Coinbase transactions are excluded.

**Confidence model:**
Binary.  The ratio threshold is an objective criterion; the raw `ratio` value
is returned for display so consumers can apply their own thresholds.

**Limitations:**
A 3-in / 1-out payment-with-change (ratio 3.0) will be flagged.  The `MIN_INPUTS = 3`
guard reduces but does not eliminate this overlap with `simple_payment`.

---

### 5. Address Reuse Detection

> `src/heuristics/addressReuse.js` · id: `address_reuse`

**What it detects:**
Transactions where at least one output script matches a script from the
transaction's own inputs (via resolved prevouts), revealing that the sender is
recycling an address for change — a significant privacy leak.

**How it is detected/computed:**
Builds a set of all input `scriptPubKey` values (from prevout resolution), then
tests each output `scriptPubKey` for membership.  All matching output indices
are returned in `reused_indices`.

**Confidence model:**
Binary.  A script-equality match is deterministic.

**Limitations:**
Requires prevout scripts resolved from `rev*.dat`.  Without undo data the
heuristic returns `detected: false` rather than an error, making it silently
conservative in the absence of prevout information.

---

### 6. Round-Number Payment Detection

> `src/heuristics/roundNumberPayment.js` · id: `round_number_payment`

**What it detects:**
Outputs whose satoshi value is a round human-friendly denomination, pinpointing
the payment destination and implicitly identifying the non-round output as
change.

**How it is detected/computed:**
Each output's value is tested for divisibility by one of four cadences:
1 000 000 sat (0.01 BTC), 10 000 000 sat (0.1 BTC), 100 000 000 sat (1 BTC),
500 000 000 sat (5 BTC).  The smallest matching cadence is reported.

**Confidence model:**
Binary.  The matching output indices and triggering cadence are returned for
downstream use by the change-detection heuristic's round-number signal.

**Limitations:**
Round amounts can arise by coincidence, especially at smaller cadences (e.g.
1 000 000 sat = 0.01 BTC is fairly common even for genuine change).  At higher
cadences false-positive rates decrease.

---

## Trade-offs and Design Decisions

| Decision | Rationale |
|---|---|
| **No external node / RPC** | Runs air-gapped from fixture files; simplifies deployment and grading. |
| **Pure Node.js `node:http`** | Avoids adding Express as a production runtime dependency — the API has only four routes. |
| **Plugin heuristic architecture** | New heuristics can be added without modifying the engine; each module is independently testable in isolation. |
| **Rev.dat undo files for prevouts** | The only way to recover input values without an indexed UTXO set or node RPC. Limits analysis to blocks whose undo data is present. |
| **Single classification label per tx** | Simplifies reporting and reliable colour-coding in the UI; the full heuristic map is always available for deeper inspection. |
| **React + Vite SPA with API backend** | Front-end and back-end evolve independently; the Vite dev proxy lets the UI run against live data without rebuilding. |
| **Confidence as a continuous float** | Allows consumers to apply their own thresholds rather than encoding an opinionated low/medium/high bucketing into the schema. |
| **Classifier priority order: coinjoin > consolidation > ...** | Prevents CIOH (which also fires on CoinJoins) from masking the more specific privacy-relevant label. |
| **BIP34 height from coinbase scriptSig** | No separate index needed; deterministic decoding from the first push-data of the coinbase input. |

---

## References

- Nakamoto, S. (2008). *Bitcoin: A Peer-to-Peer Electronic Cash System* §10 Privacy.
  <https://bitcoin.org/bitcoin.pdf>
- Möser, M. et al. (2017). "An Empirical Analysis of Traceability in the Monero
  Blockchain." — CoinJoin equal-output criterion generalised from this framework.
- Harrigan, M. & Fretter, C. (2016). "The Unreasonable Effectiveness of Address
  Clustering." — CIOH formalisation and address-reuse survey.
- Andresen, G. (2012). *BIP 34: Block v2, Height in Coinbase*.
  <https://github.com/bitcoin/bips/blob/master/bip-0034.mediawiki>
- Bitcoin Wiki — Script: <https://en.bitcoin.it/wiki/Script>
- Bitcoin Developer Reference — Serialization formats:
  <https://developer.bitcoin.org/reference/transactions.html>
- Maxwell, G. (2013). *CoinJoin: Bitcoin privacy for the real world*.
  BitcoinTalk thread: <https://bitcointalk.org/index.php?topic=279249>
