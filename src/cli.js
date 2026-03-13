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

import { parseBlockFile, loadXorKey, readVarInt } from './parser/blockParser.js';
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
const MAX_MONEY_SATS = 2_100_000_000_000_000;

// ── Fee/vsize validation helpers ────────────────────────────────────────────

/**
 * CompactSize encoded byte width for a non-negative integer.
 *
 * @param {number} n
 * @returns {number}
 */
function compactSizeBytes(n) {
    if (n < 0xfd) return 1;
    if (n <= 0xffff) return 3;
    if (n <= 0xffffffff) return 5;
    return 9;
}

/**
 * Compute transaction vsize per BIP141.
 *
 * @param {import('./parser/transactionParser.js').DecodedTransaction} tx
 * @returns {number}
 */
function computeVsize(tx) {
    if (!tx.segwit) return tx.size;

    let witnessBytes = 2; // marker + flag
    for (const input of tx.vin) {
        const stack = input.witness ?? [];
        witnessBytes += compactSizeBytes(stack.length);
        for (const item of stack) {
            const itemLen = item.length / 2;
            witnessBytes += compactSizeBytes(itemLen) + itemLen;
        }
    }

    if (witnessBytes >= tx.size) return tx.size;

    const baseSize = tx.size - witnessBytes;
    const weight = baseSize * 4 + witnessBytes;
    return Math.ceil(weight / 4);
}

/**
 * Compute fee metrics for one non-coinbase transaction.
 *
 * @param {import('./parser/transactionParser.js').DecodedTransaction} tx
 * @param {Array<{ value_sats: number }>} prevouts
 * @returns {{ fee_sats: number, vsize: number, fee_rate_sat_vb: number, input_total: number, output_total: number }}
 */
function computeFeeMetrics(tx, prevouts) {
    const input_total = prevouts.reduce((sum, p) => sum + p.value_sats, 0);
    const output_total = tx.vout.reduce((sum, o) => sum + o.value_sats, 0);
    const fee_sats = input_total - output_total;
    const vsize = computeVsize(tx);
    const fee_rate_sat_vb = fee_sats / vsize;
    return { fee_sats, vsize, fee_rate_sat_vb, input_total, output_total };
}

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

// ── Undo alignment helpers ──────────────────────────────────────────────────

/**
 * Read the input count from a raw transaction buffer.
 *
 * This only walks the transaction prefix up to vin count and does not parse
 * scripts or outputs, so it is much cheaper than full decode.
 *
 * @param {Buffer} rawTx
 * @returns {number}
 */
function readInputCountFromRawTx(rawTx) {
    let pos = 4; // version
    const isSegwit = rawTx[pos] === 0x00 && rawTx[pos + 1] !== 0x00;
    if (isSegwit) pos += 2;
    return readVarInt(rawTx, pos).value;
}

/**
 * Build a stable signature for one raw block using non-coinbase input counts.
 *
 * Signature format:
 *   <non_coinbase_tx_count>|<in1>,<in2>,...,<inN>
 *
 * @param {{ raw_transactions: Buffer[] }} rawBlock
 * @returns {string}
 */
function buildRawBlockUndoSignature(rawBlock) {
    const counts = [];
    for (let i = 1; i < rawBlock.raw_transactions.length; i++) {
        try {
            counts.push(readInputCountFromRawTx(rawBlock.raw_transactions[i]));
        } catch {
            // Keep a deterministic placeholder so signatures remain comparable.
            counts.push(-1);
        }
    }
    return `${counts.length}|${counts.join(',')}`;
}

/**
 * Build a stable signature for one rev block using txinundo counts.
 *
 * @param {{ txUndos?: Array<Array<unknown>> }} revBlock
 * @returns {string}
 */
function buildRevBlockUndoSignature(revBlock) {
    const counts = Array.isArray(revBlock?.txUndos)
        ? revBlock.txUndos.map(coins => coins.length)
        : [];
    return `${counts.length}|${counts.join(',')}`;
}

/**
 * Align rev blocks to blk blocks using per-transaction input-count signatures.
 *
 * This is robust to file-order differences between blk and rev records while
 * preserving strict in-block ordering of undo entries.
 *
 * @param {Array<{ raw_transactions: Buffer[] }>} rawBlocks
 * @param {Array<{ txUndos?: Array }>} revBlocks
 * @returns {{ aligned: Array<{ txUndos: Array }>, matched: number, unmatched: number }}
 */
function alignRevBlocks(rawBlocks, revBlocks) {
    const aligned = Array.from({ length: rawBlocks.length }, () => ({ txUndos: [] }));

    const revBuckets = new Map();
    for (let i = 0; i < revBlocks.length; i++) {
        const key = buildRevBlockUndoSignature(revBlocks[i]);
        const bucket = revBuckets.get(key) ?? [];
        bucket.push(i);
        revBuckets.set(key, bucket);
    }

    let matched = 0;
    for (let i = 0; i < rawBlocks.length; i++) {
        const key = buildRawBlockUndoSignature(rawBlocks[i]);
        const bucket = revBuckets.get(key);
        if (!bucket || bucket.length === 0) continue;

        const revIdx = bucket.shift();
        aligned[i] = { txUndos: Array.isArray(revBlocks[revIdx]?.txUndos) ? revBlocks[revIdx].txUndos : [] };
        matched++;
    }

    return { aligned, matched, unmatched: rawBlocks.length - matched };
}

/**
 * Best-effort fallback alignment when full signature matching fails.
 *
 * @param {Array<{ raw_transactions: Buffer[] }>} rawBlocks
 * @param {Array<{ txUndos?: Array }>} revBlocks
 * @param {Array<{ txUndos: Array }>} aligned
 * @returns {number} number of additional blocks matched
 */
function fillAlignmentByUndoCount(rawBlocks, revBlocks, aligned) {
    const usedRev = new Set();
    for (const entry of aligned) {
        if (!entry.txUndos || entry.txUndos.length === 0) continue;

        const idx = revBlocks.findIndex(r => r.txUndos === entry.txUndos);
        if (idx >= 0) usedRev.add(idx);
    }

    let additional = 0;
    for (let i = 0; i < rawBlocks.length; i++) {
        if (aligned[i].txUndos.length > 0) continue;

        const expectedUndoCount = rawBlocks[i].raw_transactions.length - 1;
        const candidate = revBlocks.findIndex(
            (r, idx) => !usedRev.has(idx) && Array.isArray(r.txUndos) && r.txUndos.length === expectedUndoCount
        );

        if (candidate >= 0) {
            aligned[i] = { txUndos: revBlocks[candidate].txUndos };
            usedRev.add(candidate);
            additional++;
        }
    }

    return additional;
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
function processBlock(rawBlock, revBlock, diagnostics = null) {
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

                    // Attach prevout value directly onto each input for downstream
                    // fee/debug visibility without changing existing interfaces.
                    for (let vinIdx = 0; vinIdx < tx.vin.length; vinIdx++) {
                        tx.vin[vinIdx].prev_value = prevouts[vinIdx]?.value_sats ?? null;
                    }

                    if (diagnostics) {
                        diagnostics.totalPrevouts += prevouts.length;
                        diagnostics.nonZeroPrevouts += prevouts.filter(p => p.value_sats > 0).length;

                        for (const p of prevouts) {
                            if (p.value_sats > MAX_MONEY_SATS) {
                                diagnostics.hugePrevouts.push({
                                    txid: tx.txid,
                                    value_sats: p.value_sats,
                                });
                            }
                        }

                        const { fee_sats, vsize, fee_rate_sat_vb, input_total, output_total } = computeFeeMetrics(tx, prevouts);
                        if (!Number.isInteger(fee_sats)) {
                            diagnostics.nonIntegerFees.push({
                                txid: tx.txid,
                                fee_sats,
                                input_total,
                                output_total,
                            });
                        }
                        if (fee_rate_sat_vb > 5000) {
                            diagnostics.highFeeRates.push({ txid: tx.txid, fee_sats, vsize, fee_rate_sat_vb });
                        }
                        if (fee_rate_sat_vb < 0) {
                            diagnostics.negativeFeeRates.push({ txid: tx.txid, fee_sats, vsize, fee_rate_sat_vb });
                        }
                        if (fee_rate_sat_vb < 1 && fee_sats > 0) {
                            diagnostics.lowPositiveFeeRates.push({ txid: tx.txid, fee_sats, vsize, fee_rate_sat_vb });
                        }
                    }
                } catch {
                    // Undo coin count doesn't match input count (e.g. blk/rev
                    // file mismatch in fixtures).  Use empty prevouts so that
                    // fee stats are skipped rather than inflated by wrong data.
                    prevouts = [];
                    if (diagnostics) diagnostics.inputMismatchTxs++;
                }
            } else if (diagnostics) {
                diagnostics.missingUndoTxs++;
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

    const { aligned: alignedRevBlocks, matched, unmatched } = alignRevBlocks(rawBlocks, revBlocks);
    const fallbackMatched = fillAlignmentByUndoCount(rawBlocks, revBlocks, alignedRevBlocks);
    const totalMatched = matched + fallbackMatched;
    const totalUnmatched = rawBlocks.length - totalMatched;
    if (totalUnmatched > 0) {
        process.stderr.write(
            `Warning: aligned ${totalMatched}/${rawBlocks.length} blocks from rev data; ` +
            `${totalUnmatched} block(s) have no matching undo record\n`
        );
    }

    const blocksData = rawBlocks.map((rawBlock, idx) => {
        const revBlock = alignedRevBlocks[idx] ?? { txUndos: [] };
        const expectedUndoCount = rawBlock.raw_transactions.length - 1;

        if (revBlock.txUndos.length !== expectedUndoCount) {
            process.stderr.write(
                `Warning: block ${idx} undo tx count mismatch ` +
                `(expected ${expectedUndoCount}, got ${revBlock.txUndos.length})\n`
            );
        }

        const diagnostics = {
            missingUndoTxs: 0,
            inputMismatchTxs: 0,
            totalPrevouts: 0,
            nonZeroPrevouts: 0,
            hugePrevouts: [],
            nonIntegerFees: [],
            highFeeRates: [],
            negativeFeeRates: [],
            lowPositiveFeeRates: [],
        };

        const blockData = processBlock(rawBlock, revBlock, diagnostics);

        if (diagnostics.missingUndoTxs > 0 || diagnostics.inputMismatchTxs > 0) {
            process.stderr.write(
                `Warning: block ${idx} prevout mapping issues ` +
                `(missing_undo_txs=${diagnostics.missingUndoTxs}, ` +
                `input_mismatch_txs=${diagnostics.inputMismatchTxs})\n`
            );
        }

        if (diagnostics.totalPrevouts > 0) {
            const nonZeroRatio = diagnostics.nonZeroPrevouts / diagnostics.totalPrevouts;
            if (nonZeroRatio < 0.8) {
                process.stderr.write(
                    `Warning: block ${idx} low non-zero prevout ratio ` +
                    `(${(nonZeroRatio * 100).toFixed(1)}%)\n`
                );
            }
        }

        for (const x of diagnostics.hugePrevouts.slice(0, 5)) {
            process.stderr.write(
                `Warning: block ${idx} suspicious prevout value tx=${x.txid} ` +
                `value_sats=${x.value_sats}\n`
            );
        }
        for (const x of diagnostics.nonIntegerFees.slice(0, 5)) {
            process.stderr.write(
                `Warning: block ${idx} non-integer fee tx=${x.txid} ` +
                `fee_sats=${x.fee_sats} input_total=${x.input_total} output_total=${x.output_total}\n`
            );
        }
        for (const x of diagnostics.highFeeRates.slice(0, 5)) {
            process.stderr.write(
                `Warning: block ${idx} very high fee-rate tx=${x.txid} ` +
                `fee_rate_sat_vb=${x.fee_rate_sat_vb.toFixed(3)} fee_sats=${x.fee_sats} vsize=${x.vsize}\n`
            );
        }
        for (const x of diagnostics.negativeFeeRates.slice(0, 5)) {
            process.stderr.write(
                `Warning: block ${idx} negative fee-rate tx=${x.txid} ` +
                `fee_rate_sat_vb=${x.fee_rate_sat_vb.toFixed(3)} fee_sats=${x.fee_sats} vsize=${x.vsize}\n`
            );
        }
        for (const x of diagnostics.lowPositiveFeeRates.slice(0, 5)) {
            process.stderr.write(
                `Warning: block ${idx} low positive fee-rate tx=${x.txid} ` +
                `fee_rate_sat_vb=${x.fee_rate_sat_vb.toFixed(6)} fee_sats=${x.fee_sats} vsize=${x.vsize}\n`
            );
        }

        return blockData;
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
