#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# cli.sh — Bitcoin chain analysis CLI
#
# Usage:
#   ./cli.sh --block <blk.dat> <rev.dat> <xor.dat>
#
# Block mode:
#   - Reads blk*.dat, rev*.dat, and xor.dat
#   - Parses all blocks and transactions
#   - Applies chain analysis heuristics to every transaction
#   - Writes per-block-file outputs:
#       out/<blk_stem>.json — machine-readable analysis report
#       out/<blk_stem>.md   — human-readable Markdown report
#     where <blk_stem> is the blk filename without extension (e.g., blk04330)
#   - Exits 0 on success, 1 on error
###############################################################################

error_json() {
  local code="$1"
  local message="$2"
  printf '{"ok":false,"error":{"code":"%s","message":"%s"}}\n' "$code" "$message"
}

# --- Block mode ---
if [[ "${1:-}" != "--block" ]]; then
  error_json "INVALID_ARGS" "Usage: cli.sh --block <blk.dat> <rev.dat> <xor.dat>"
  echo "Error: This CLI only supports block mode. Use --block flag." >&2
  exit 1
fi

shift
if [[ $# -lt 3 ]]; then
  error_json "INVALID_ARGS" "Block mode requires: --block <blk.dat> <rev.dat> <xor.dat>"
  echo "Error: Block mode requires 3 file arguments: <blk.dat> <rev.dat> <xor.dat>" >&2
  exit 1
fi

BLK_FILE="$1"
REV_FILE="$2"
XOR_FILE="$3"

for f in "$BLK_FILE" "$REV_FILE" "$XOR_FILE"; do
  if [[ ! -f "$f" ]]; then
    error_json "FILE_NOT_FOUND" "File not found: $f"
    echo "Error: File not found: $f" >&2
    exit 1
  fi
done

# Create output directory
mkdir -p out

# TODO: Implement chain analysis
#   1. Read and XOR-decode blk*.dat and rev*.dat using xor.dat key
#   2. Parse 80-byte block headers
#   3. Parse all transactions in each block
#   4. Parse undo data for prevouts
#   5. Apply chain analysis heuristics to each transaction:
#      - Common Input Ownership Heuristic (CIOH)
#      - Change detection (script type matching, round numbers, output ordering)
#      - Address reuse detection
#      - CoinJoin detection (equal-value outputs, many inputs)
#      - Consolidation detection (many inputs, few outputs)
#      - Self-transfer detection
#      - Peeling chain detection
#      - OP_RETURN analysis and protocol classification
#      - Round number payment detection
#   6. Classify each transaction (simple_payment, consolidation, coinjoin, etc.)
#   7. Compute per-block and file-level statistics (fee rates, script distribution, flagged counts)
#   8. Write out/<blk_stem>.json with all blocks wrapped in a blocks array
#   9. Generate out/<blk_stem>.md Markdown report for the block file

error_json "NOT_IMPLEMENTED" "Chain analysis is not yet implemented"
echo "Error: Chain analysis is not yet implemented" >&2
exit 1
