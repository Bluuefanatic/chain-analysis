/**
 * src/heuristics/cioh.js
 *
 * Common-Input-Ownership Heuristic (CIOH)
 *
 * Background
 * ──────────
 * Introduced in Satoshi's whitepaper (§10 "Privacy"), the CIOH states that
 * when a transaction spends more than one UTXO, all of those UTXOs are assumed
 * to be controlled by the same wallet.  This assumption holds for the vast
 * majority of ordinary transactions where a single user consolidates coins to
 * meet the target payment amount.
 *
 * The heuristic is *not* applicable to:
 *   - Coinbase transactions (single null-hash input, vout 0xFFFFFFFF)
 *   - CoinJoin and PAYJOIN transactions (multiple independent signers)
 *     → these are NOT filtered here; callers should apply a coinjoin guard
 *       separately if needed.
 *
 * Output
 * ──────
 * {
 *   detected:    boolean   — true when ≥ 2 non-coinbase inputs are present
 *   input_count: number    — total number of transaction inputs
 *   confidence:  number    — 0.0 – 1.0 score (see below)
 * }
 *
 * Confidence model
 * ────────────────
 * The raw CIOH assumption weakens as input count grows because high-input-count
 * transactions are more likely to be CoinJoins.  This implementation uses a
 * simple exponential decay:
 *
 *   confidence = BASE × exp(−DECAY × (input_count − 2))
 *
 *   BASE  = 0.9   (2-input case: strong prior)
 *   DECAY = 0.12  (each additional input costs ~11 pp)
 *
 * input_count = 1 → detected = false, confidence = 0.0
 * input_count = 2 → detected = true,  confidence ≈ 0.90
 * input_count = 5 → detected = true,  confidence ≈ 0.63
 * input_count = 10→ detected = true,  confidence ≈ 0.35
 *
 * Compatibility with HeuristicEngine
 * ────────────────────────────────────
 * The exported object satisfies the Heuristic interface expected by
 * HeuristicEngine: { id: string, analyze: (tx, context) → result }.
 *
 * Public API
 * ──────────
 *   cioh.id        — 'cioh'
 *   cioh.analyze(tx, context?) → CiohResult
 *
 *   isCoinbase(tx) — exported helper, used by changeDetection.js
 */

const COINBASE_PREV_TXID = '0'.repeat(64);
const COINBASE_VOUT = 0xffffffff;

const CONFIDENCE_BASE = 0.9;
const CONFIDENCE_DECAY = 0.12;

// ── Exported helper ───────────────────────────────────────────────────────────

/**
 * Return true when `tx` is a coinbase transaction.
 *
 * @param {{ vin: Array<{ prev_txid: string, vout: number }> }} tx
 * @returns {boolean}
 */
export function isCoinbase(tx) {
    const vin = Array.isArray(tx?.vin) ? tx.vin : [];
    return (
        vin.length === 1 &&
        vin[0].prev_txid === COINBASE_PREV_TXID &&
        vin[0].vout === COINBASE_VOUT
    );
}

// ── Heuristic ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CiohResult
 * @property {boolean} detected    - True when the heuristic applies.
 * @property {number}  input_count - Number of inputs in the transaction.
 * @property {number}  confidence  - 0.0 – 1.0 confidence score.
 */

export const cioh = {
    id: 'cioh',

    /**
     * @param {{ vin: Array<{ prev_txid: string, vout: number }> }} tx
     * @returns {CiohResult}
     */
    analyze(tx) {
        const vin = Array.isArray(tx?.vin) ? tx.vin : [];
        const inputCount = vin.length;

        if (isCoinbase(tx) || inputCount < 2) {
            return { detected: false, input_count: inputCount, confidence: 0.0 };
        }

        const confidence =
            CONFIDENCE_BASE * Math.exp(-CONFIDENCE_DECAY * (inputCount - 2));

        return {
            detected: true,
            input_count: inputCount,
            confidence: Math.round(confidence * 1000) / 1000, // 3 d.p.
        };
    },
};
