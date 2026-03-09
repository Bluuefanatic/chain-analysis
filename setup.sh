#!/usr/bin/env bash
# Exit immediately if any command fails, treat unset variables as errors,
# and propagate errors through pipes.
set -euo pipefail

###############################################################################
# setup.sh — One-time environment setup for the Sherlock chain-analysis tool.
#
# Steps:
#   1. Change working directory to the repository root so that relative paths
#      (fixtures/, node_modules/, etc.) resolve correctly regardless of where
#      the script is invoked from.
#   2. Install Node.js dependencies declared in package.json.
#   3. Decompress every fixtures/*.dat.gz file so that blk*.dat, rev*.dat, and
#      xor.dat are available for the CLI and grader to read.
###############################################################################

# ── Step 1: resolve repo root ────────────────────────────────────────────────
# SCRIPT_DIR is the directory that contains this script (i.e. the repo root).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
echo "Working directory: $SCRIPT_DIR"

# ── Step 2: install Node.js dependencies ─────────────────────────────────────
# Requires Node.js ≥18 and npm to be on PATH.
# `npm ci` is preferred in CI (reproducible from package-lock.json); fall back
# to `npm install` when no lock-file is present yet.
if [[ -f package-lock.json ]]; then
  echo "Installing Node.js dependencies (npm ci)..."
  npm ci
else
  echo "Installing Node.js dependencies (npm install)..."
  npm install
fi

# ── Step 3: decompress block fixture files ───────────────────────────────────
# Each .dat.gz file is decompressed with -k (keep original) so both the
# compressed archive and the raw .dat file coexist in fixtures/.
# The loop is skipped silently when no .dat.gz files are present.
shopt -s nullglob           # prevent literal "fixtures/*.dat.gz" if nothing matches
for gz in fixtures/*.dat.gz; do
  dat="${gz%.gz}"           # strip the .gz suffix to get the target filename
  if [[ ! -f "$dat" ]]; then
    echo "Decompressing $(basename "$gz") → $(basename "$dat")..."
    gunzip -k "$gz"         # -k keeps the original .gz alongside the output
  else
    echo "Already decompressed: $(basename "$dat") (skipping)"
  fi
done

echo ""
echo "Setup complete — ready to run ./cli.sh and ./web.sh"
