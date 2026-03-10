/**
 * src/cli.js
 *
 * CLI entry point for the Sherlock chain-analysis engine.
 *
 * Invoked by cli.sh:
 *   node src/cli.js --block <blk.dat> <rev.dat> <xor.dat>
 *
 * On success: exits 0 (no JSON output — reports are written to out/).
 * On error:   prints structured JSON to stdout and exits 1.
 *   { "ok": false, "error": { "code": "...", "message": "..." } }
 *
 * Pipeline
 * ────────
 *   1. Load XOR key from xor.dat (null = not obfuscated)
 *   2. Parse blk*.dat  → raw block envelopes
 *   3. Parse rev*.dat  → undo coins per non-coinbase tx
 *   4. For every block:
 *      a. Decode each raw transaction
 *      b. Resolve prevouts for non-coinbase transactions
 *      c. Decode BIP34 block height from coinbase scriptSig
 *      d. Run all six heuristics on every transaction
 *      e. Classify each transaction
 *   5. Write out/<blk_stem>.json  (JSON report)
 *   6. Write out/<blk_stem>.md    (Markdown report)
 */

import path from 'node:path';
import process from 'node:process';

import { parseBlockFile, loadXorKey } from './parser/blockParser.js';
import { decodeTransaction } from './parser/transactionParser.js';
import { parseRevFile, resolvePrevouts } from './parser/revParser.js';

import { isCoinbase } from './heuristics/cioh.js';
import { cioh } from './heuristics/cioh.js';
import { changeDetection } from './heuristics/changeDetection.js';
import { coinjoin } from './heuristics/coinjoin.js';
import { consolidation } from './heuristics/consolidation.js';
import { addressReuse } from './heuristics/addressReuse.js';
import { roundNumberPayment } from './heuristics/roundNumberPayment.js';

import { classifyTransaction } from './analysis/classifier.js';
import { generateJsonReport } from './reports/jsonReport.js';
import { generateMarkdownReport } from './reports/markdownReport.js';

// ── Error helpers ─────────────────────────────────────────────────────────────

/**
 * Print a structured error JSON to stdout and exit with code 1.
 *
 * @param {string} code     Machine-readable error code (UPPER_SNAKE_CASE).
 * @param {string} message  Human-readable description.
 */
function fatal(code, message) {
    process.stdout.write(
        JSON.stringify({ ok: false, error: { code, message } }) + '\n'
    );
    process.exit(1);
}

// ── BIP34 block-height decoder ────────────────────────────────────────────────

/**
 * Decode the block height from the coinbase scriptSig (BIP34).
 *
 * BIP34 mandates that the first item pushed onto the stack in a coinbase
 * scriptSig encodes the block height as a little-endian integer:
 *   byte 0:      push-data length n
 *   bytes 1..n:  LE-encoded block height
 *
 * Pre-BIP34 blocks (height < 227,835) do not contain a height and will
 * return null.
 *
 * @param {{ scriptSig: string }} coinbaseTx  Decoded coinbase transaction.
 * @returns {number|null}
 */
function decodeBip34Height(coinbaseTx) {
    try {
        const scriptSig = coinbaseTx.vin[0]?.scriptSig ?? '';
        const buf = Buffer.from(scriptSig, 'hex');
        if (buf.length < 2) return null;

        const pushLen = buf[0];
        if (pushLen === 0 || pushLen > buf.length - 1) return null;
        if (pushLen > 5) return null; // height would exceed safe integer range

        // Read pushLen bytes as LE integer
        let height = 0;
        for (let i = 0; i < pushLen; i++) {
            height += buf[1 + i] * Math.pow(256, i);
        }
        return height;
    } catch {
        return null;
    }
}

// ── Heuristic runner ──────────────────────────────────────────────────────────

const HEURISTICS = [cioh, changeDetection, coinjoin, consolidation, addressReuse, roundNumberPayment];

/**
 * Run every heuristic on a single decoded transaction and return the results
 * map.  Errors from individual heuristics are isolated.
 *
 * @param {object} tx       Decoded transaction.
 * @param {object} context  { prevouts: [...] }
 * @returns {Record<string, object>}
 */
function runHeuristics(tx, context) {
    const results = {};
    for (const h of HEURISTICS) {
        try {
            results[h.id] = h.analyze(tx, context);
        } catch (err) {
            results[h.id] = {
                detected: false,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
    return results;
}

// ── Block processor ───────────────────────────────────────────────────────────

/**
 * Process a single block: decode all transactions, resolve prevouts, run
 * heuristics and classifier, and return a BlockEntry ready for the reporters.
 *
 * @param {{
 *   block_hash:       string,
 *   timestamp:        number,
 *   raw_transactions: Buffer[]
 * }} rawBlock  One element from parseBlockFile().blocks
 * @param {{
 *   txUndos: Array<Array<{ value_sats: number, script_pubkey: string }>>
 * }} revBlock  Matching element from parseRevFile().blocks (or stub)
 * @returns {{
 *   block_hash:   string,
 *   block_height: number|null,
 *   timestamp:    number,
 *   transactions: Array
 * }}
 */
function processBlock(rawBlock, revBlock) {
    const { block_hash, timestamp, raw_transactions } = rawBlock;
    const txUndos = revBlock?.txUndos ?? [];

    const transactions = [];
    let nonCoinbaseIdx = 0; // index into txUndos (skips the coinbase at tx[0])

    for (let i = 0; i < raw_transactions.length; i++) {
        let tx;
        try {
            tx = decodeTransaction(raw_transactions[i]);
        } catch (err) {
            // Skip undecipherable transactions rather than aborting the whole block
            continue;
        }

        // Resolve prevouts: coinbase has no undo entry
        let prevouts = [];
        if (!isCoinbase(tx)) {
            const undoCoins = txUndos[nonCoinbaseIdx];
            nonCoinbaseIdx++;
            if (undoCoins) {
                try {
                    prevouts = resolvePrevouts(tx, undoCoins);
                } catch {
                    // Undo coin count doesn't match input count (e.g. blk/rev
                    // file mismatch in fixtures).  Use empty prevouts so that
                    // fee stats are skipped rather than inflated by wrong data.
                    prevouts = [];
                }
            }
        }

        const context = { prevouts };
        const heuristics = runHeuristics(tx, context);
        const { classification } = classifyTransaction(tx, context);

        transactions.push({ tx, prevouts, heuristics, classification });
    }

    // BIP34 block height from coinbase scriptSig
    let block_height = null;
    if (raw_transactions.length > 0) {
        try {
            const coinbaseTx = decodeTransaction(raw_transactions[0]);
            block_height = decodeBip34Height(coinbaseTx);
        } catch {
            // height stays null
        }
    }

    return { block_hash, block_height, timestamp, transactions };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    const args = process.argv.slice(2);

    // Argument validation
    if (args[0] !== '--block') {
        fatal('INVALID_ARGS', 'Usage: cli.js --block <blk.dat> <rev.dat> <xor.dat>');
    }
    if (args.length < 4) {
        fatal('INVALID_ARGS', 'Block mode requires: --block <blk.dat> <rev.dat> <xor.dat>');
    }

    const [, blkPath, revPath, xorPath] = args;

    // File-existence checks are already done by cli.sh before we are invoked;
    // we repeat them here so the module can also be called directly.
    for (const [label, f] of [['blk', blkPath], ['rev', revPath], ['xor', xorPath]]) {
        try {
            const { accessSync, constants } = await import('node:fs');
            accessSync(f, constants.R_OK);
        } catch {
            fatal('FILE_NOT_FOUND', `Cannot read ${label} file: ${f}`);
        }
    }

    // ── 1. Load XOR key ───────────────────────────────────────────────────────
    let xorKey = null;
    try {
        xorKey = loadXorKey(xorPath);
    } catch (err) {
        fatal('XOR_READ_ERROR', `Failed to read xor.dat "${xorPath}": ${err.message}`);
    }

    // ── 2. Parse blk*.dat ─────────────────────────────────────────────────────
    let blkResult;
    try {
        blkResult = parseBlockFile(blkPath, xorKey);
    } catch (err) {
        fatal('PARSE_ERROR', `Failed to parse block file "${blkPath}": ${err.message}`);
    }

    // ── 3. Parse rev*.dat ─────────────────────────────────────────────────────
    let revResult;
    try {
        revResult = parseRevFile(revPath, xorKey);
    } catch (err) {
        // Rev file parse errors are non-fatal — we can still produce reports,
        // just without prevout data (fee stats will show zeros).
        process.stderr.write(
            `Warning: failed to parse rev file "${revPath}": ${err.message}\n`
        );
        revResult = { blocks: [] };
    }

    // ── 4. Process every block ────────────────────────────────────────────────
    const { blocks: rawBlocks } = blkResult;
    const { blocks: revBlocks } = revResult;

    const blocksData = rawBlocks.map((rawBlock, idx) => {
        const revBlock = revBlocks[idx] ?? { txUndos: [] };
        // Sanity check: rev undo count must equal non-coinbase tx count.
        // If they differ, the rev file is misaligned with the blk file for this
        // block (known issue with some fixture snapshots).  Use empty txUndos so
        // computeFeeStats skips these transactions rather than using wrong data.
        const expectedUndoCount = rawBlock.raw_transactions.length - 1;
        const safeRevBlock =
            revBlock.txUndos.length === expectedUndoCount
                ? revBlock
                : { txUndos: [] };
        return processBlock(rawBlock, safeRevBlock);
    });

    // ── 5 & 6. Generate reports ───────────────────────────────────────────────
    const filename = path.basename(blkPath);
    const outDir = path.join(process.cwd(), 'out');

    try {
        await generateJsonReport(blkPath, blocksData, { outDir });
    } catch (err) {
        fatal('REPORT_ERROR', `Failed to write JSON report: ${err.message}`);
    }

    try {
        await generateMarkdownReport(blkPath, blocksData, { outDir });
    } catch (err) {
        fatal('REPORT_ERROR', `Failed to write Markdown report: ${err.message}`);
    }

    const stem = filename.replace(/\.dat$/i, '');
    process.stderr.write(
        `✓ Wrote out/${stem}.json and out/${stem}.md ` +
        `(${blocksData.length} block${blocksData.length !== 1 ? 's' : ''}, ` +
        `${blocksData.reduce((s, b) => s + b.transactions.length, 0)} transactions)\n`
    );
}

main().catch(err => {
    fatal('UNEXPECTED_ERROR', err.message ?? String(err));
});
