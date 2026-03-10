/**
 * src/analysis/feeCalculator.js
 *
 * Compute transaction fee rates from decoded transactions with resolved prevouts.
 *
 * Fee model
 * ─────────
 *   fee      = sum(input values) − sum(output values)
 *   fee_rate = fee / virtual_size   (sat per vbyte)
 *
 * Virtual size (BIP-141)
 * ──────────────────────
 *   Legacy:  vsize = size  (byte-for-byte)
 *   SegWit:  weight     = base_size × 4 + witness_bytes
 *            vsize      = ceil(weight / 4)
 *
 *   where:
 *     witness_bytes = 2 (marker + flag) + per-input witness data
 *     base_size     = total_size − witness_bytes
 *
 * Public API
 * ──────────
 *   computeFeeStats(txEntries)  → FeeStats
 *
 *   txEntries: Array<{ tx: DecodedTransaction, prevouts: Array<{ value_sats }> }>
 *
 *   FeeStats: { min_sat_vb, max_sat_vb, median_sat_vb, mean_sat_vb }
 *
 * Coinbase transactions (prev_txid all-zeros, vout 0xFFFFFFFF) are silently
 * skipped.  computeFeeStats throws when no non-coinbase transactions remain.
 */

// ── CompactSize varint byte-width helper ──────────────────────────────────────

/**
 * Number of bytes used to encode `n` as a Bitcoin CompactSize varint.
 *
 * @param {number} n
 * @returns {number}
 */
function varIntSize(n) {
    if (n < 0xfd) return 1;
    if (n <= 0xffff) return 3;
    if (n <= 0xffffffff) return 5;
    return 9;
}

// ── Virtual size ──────────────────────────────────────────────────────────────

/**
 * Compute the virtual size (vbytes) of a decoded transaction.
 *
 * For legacy transactions vsize equals the total serialized size.
 * For SegWit transactions the witness portion is discounted per BIP-141.
 *
 * @param {import('../parser/transactionParser.js').DecodedTransaction} tx
 * @returns {number}
 */
function getVirtualSize(tx) {
    if (!tx.segwit) return tx.size;

    // Tally the witness bytes that appear on the wire beyond the base
    // serialization.  These are: the 2-byte marker+flag prefix, then for
    // each input a varint for the number of stack items, followed by
    // varint+bytes for each item.
    let witnessBytes = 2; // marker (0x00) + flag (0x01)

    for (const input of tx.vin) {
        const stack = input.witness ?? [];
        witnessBytes += varIntSize(stack.length);
        for (const item of stack) {
            const itemLen = item.length / 2; // hex chars → bytes
            witnessBytes += varIntSize(itemLen) + itemLen;
        }
    }

    const baseSize = tx.size - witnessBytes;
    const weight = baseSize * 4 + witnessBytes;
    return Math.ceil(weight / 4);
}

// ── Coinbase detection ────────────────────────────────────────────────────────

/**
 * Return true when the transaction is a coinbase.
 *
 * A coinbase has exactly one input whose prev_txid is the null hash (all
 * zeros) and whose vout index is 0xFFFFFFFF.
 *
 * @param {import('../parser/transactionParser.js').DecodedTransaction} tx
 * @returns {boolean}
 */
function isCoinbase(tx) {
    return (
        tx.vin.length === 1 &&
        tx.vin[0].prev_txid === '0'.repeat(64) &&
        tx.vin[0].vout === 0xffffffff
    );
}

// ── Statistics helpers ────────────────────────────────────────────────────────

/**
 * Compute the median of an already-sorted numeric array.
 *
 * @param {number[]} sorted  Array in ascending order; must be non-empty.
 * @returns {number}
 */
function medianOfSorted(sorted) {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} FeeStats
 * @property {number} min_sat_vb     - Minimum fee rate across all transactions (sat/vbyte)
 * @property {number} max_sat_vb     - Maximum fee rate (sat/vbyte)
 * @property {number} median_sat_vb  - Median fee rate (sat/vbyte)
 * @property {number} mean_sat_vb    - Arithmetic mean fee rate (sat/vbyte)
 */

/**
 * Compute fee-rate statistics over a set of transactions.
 *
 * Each entry pairs a decoded transaction with the resolved prevout coins for
 * its inputs (e.g. as returned by revParser.resolvePrevouts).  Coinbase
 * transactions are silently skipped.
 *
 * @param {Array<{
 *   tx:       import('../parser/transactionParser.js').DecodedTransaction,
 *   prevouts: Array<{ value_sats: number }>
 * }>} txEntries
 * @returns {FeeStats}
 * @throws {Error} When there are no non-coinbase transactions to analyse.
 * @throws {Error} When a fee computes to a negative value (prevout mismatch).
 */
export function computeFeeStats(txEntries) {
    const feeRates = [];

    for (const { tx, prevouts } of txEntries) {
        if (isCoinbase(tx)) continue;

        const inputTotal = prevouts.reduce((sum, p) => sum + p.value_sats, 0);
        const outputTotal = tx.vout.reduce((sum, o) => sum + o.value_sats, 0);
        const fee = inputTotal - outputTotal;

        if (fee < 0) {
            // Prevouts missing or mismatched for this tx — skip rather than abort
            // the entire block's fee stats. This can happen for edge-case txns
            // where undo data was unavailable.
            continue;
        }

        const vsize = getVirtualSize(tx);
        feeRates.push(fee / vsize);
    }

    if (feeRates.length === 0) {
        throw new Error('computeFeeStats: no non-coinbase transactions provided');
    }

    feeRates.sort((a, b) => a - b);

    const min_sat_vb = feeRates[0];
    const max_sat_vb = feeRates[feeRates.length - 1];
    const median_sat_vb = medianOfSorted(feeRates);
    const mean_sat_vb = feeRates.reduce((s, r) => s + r, 0) / feeRates.length;

    return { min_sat_vb, max_sat_vb, median_sat_vb, mean_sat_vb };
}
