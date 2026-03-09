1
You are a senior Bitcoin protocol engineer and JavaScript backend developer.

In this repository, implement the setup.sh script required by the Week 3 Sherlock challenge.

Requirements from the README:
- Install project dependencies.
- Decompress all fixture files in fixtures/*.dat.gz.
- Ensure blk*.dat, rev*.dat and xor.dat are available for analysis.

Tasks:
1. Write setup.sh that:
   - runs npm install
   - decompresses all .dat.gz files inside fixtures/
   - keeps the decompressed files alongside the originals
2. Ensure the script exits with non-zero code on failure.
3. Add comments explaining what each step does.

Also suggest a minimal package.json with dependencies suitable for a Node.js chain-analysis tool.

Do not implement chain analysis yet.



2
Implement a Bitcoin blk.dat parser in Node.js.

Goal:
Extract blocks and raw transaction data from blk*.dat files.

Constraints from the Sherlock challenge:
- We must parse blk.dat, rev.dat and xor.dat locally.
- No RPC or node connections.

Requirements:
Create module src/parser/blockParser.js

Function:
parseBlockFile(filePath)

Output structure:
{
  blocks: [
    {
      block_hash: string,
      timestamp: number,
      raw_transactions: Buffer[]
    }
  ]
}

Notes:
- Use Bitcoin block serialization format.
- Parse the block header and transaction count.
- Extract raw transaction bytes but do not decode them yet.

Include unit tests using a small sample block buffer.
Focus on correctness and readability.



3
Extend the parser to decode transactions from raw bytes.

Create module:
src/parser/transactionParser.js

Decode the following fields:

txid
inputs
outputs
scriptSig
scriptPubKey
value
sequence

Return structure:

{
  txid,
  vin: [
    { prev_txid, vout, scriptSig, sequence }
  ],
  vout: [
    { value_sats, scriptPubKey }
  ],
  size
}

Constraints:
- Do not execute scripts.
- Do not validate signatures.

Add unit tests using known raw transactions.



4
Implement prevout resolution using rev.dat undo files.

Goal:
Determine the value and script type of transaction inputs.

Create module:
src/parser/revParser.js

Function:
resolvePrevouts(transaction, revFile)

Return:

[
  {
    value_sats,
    script_pubkey
  }
]

Use this to compute transaction fees later.

Add unit tests verifying correct prevout extraction.


5
Create module src/analysis/feeCalculator.js

Goal:
Compute transaction fee rates.

For each transaction:

fee = sum(inputs) - sum(outputs)
fee_rate = fee / virtual_size

Return statistics:

min_sat_vb
max_sat_vb
median_sat_vb
mean_sat_vb

Ignore coinbase transactions.

Add tests verifying correct statistics calculation.




6
Implement Bitcoin script type detection.

Create module:
src/analysis/scriptTypes.js

Detect:

p2wpkh
p2tr
p2sh
p2pkh
p2wsh
op_return
unknown

Function:
detectScriptType(scriptPubKey)

Return enum string.

Include tests with known script examples.




7
Design a heuristic engine for transaction analysis.

Create module:
src/analysis/heuristicEngine.js

Design a plugin architecture:

interface Heuristic {
  id: string
  analyze(tx, context)
}

The engine must run all heuristics on every transaction and return results like:

{
  cioh: { detected: true },
  change_detection: { detected: false }
}

Add tests verifying heuristics execution pipeline.




8
Implement the mandatory heuristics:

1) Common Input Ownership (cioh)
Detect when a transaction has multiple inputs.

2) Change Detection
Identify likely change output using:
- script type match
- value comparison
- round number detection

Output format:

{
 detected: true,
 likely_change_index,
 method,
 confidence
}

Modules:

src/heuristics/cioh.js
src/heuristics/changeDetection.js

Include tests.




9
Implement at least 3 additional heuristics from the Sherlock challenge:

address_reuse
coinjoin
consolidation
round_number_payment

Each module should return:

{
 detected: boolean
}

Place them in:

src/heuristics/

Add tests verifying heuristic detection logic.




10
Implement transaction classification.

Create module:

src/analysis/classifier.js

Possible classifications:

simple_payment
consolidation
coinjoin
self_transfer
batch_payment
unknown

Use heuristic results to determine classification.

Add tests verifying classification behavior.




11
Implement JSON report generation that strictly follows the Sherlock challenge schema.

Create module:
src/reports/jsonReport.js

Output file:
out/<blk_stem>.json

Ensure:

block_count matches blocks array
aggregated summaries match per-block data
heuristics_applied contains at least 5 heuristics
flagged_transactions matches detected heuristics

Add schema validation tests.




12
Implement Markdown report generation.

Module:
src/reports/markdownReport.js

Output:
out/<blk_stem>.md

Include:

file overview
summary statistics
per-block sections
tables of heuristic results
notable transactions

Ensure file size > 1KB.

Use Markdown tables and headings.




13
Implement the CLI required by the Sherlock challenge.

Entry script: cli.sh

Command:

./cli.sh --block <blk.dat> <rev.dat> <xor.dat>

Responsibilities:

parse blocks
run heuristics
generate JSON + Markdown reports

Errors must be returned as structured JSON:

{
 ok:false,
 error:{
   code:"",
   message:""
 }
}




14
Implement backend API for the web visualizer.

Create server:

src/web/server.js

Endpoints:

GET /api/health
GET /api/block/:height
GET /api/tx/:txid

Load analysis data from out/*.json.

Respect PORT environment variable.
Default port 3000.




15
Build a simple web UI to explore chain analysis results.

Stack:
React + Vite

Features:

block statistics
transaction list
heuristic results
highlight coinjoins and consolidations
filter by classification

Use color labels for classifications.




16
Write APPROACH.md for the Sherlock challenge.

Sections:

Heuristics implemented
Detection logic
Confidence model
Limitations

Architecture overview
Design trade-offs
References

Minimum length: 500 bytes.