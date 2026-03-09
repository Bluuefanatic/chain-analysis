/**
 * src/heuristics/changeDetection.js
 *
 * Change-Output Detection Heuristic
 *
 * Background
 * ──────────
 * Most Bitcoin transactions have one "payment" output and one "change" output
 * that returns the unspent portion of the inputs back to the sender.
 * Identifying which output is change is a key step in wallet clustering.
 *
 * Three independent signals are evaluated and combined:
 *
 *   1. Script-type match
 *      The change output usually has the same script type as the input scripts
 *      (e.g. a P2WPKH wallet sends change back to a P2WPKH address).
 *      An output whose script type matches the *majority* input script type
 *      scores higher.
 *
 *   2. Value comparison
 *      The payment output tends to be the larger (or round) value; the change
 *      output is whichever output is smaller.  When there are exactly two
 *      outputs without a clear round-value winner, the smaller output is
 *      preferred as change.
 *
 *   3. Round-number heuristic
 *      Payment amounts are frequently round (multiples of 10 000 sat, 100 000
 *      sat, 1 000 000 sat, etc.).  An output whose value is NOT round is more
 *      likely to be change; the one with the non-round value wins.
 *
 * Scoring
 * ───────
 * Each signal awards points.  The index with the highest total is the
 * likely change.  The final confidence is the winning score divided by the
 * maximum possible score (3.0), clamped to [0, 1].
 *
 *   Signal                 Points awarded to the matching output index
 *   ─────────────────────  ────────────────────────────────────────────
 *   script_type_match      1.0
 *   smaller_value          0.5
 *   non_round_value        1.0   (uses cadences 10k / 100k / 1M sat)
 *
 * Output format
 * ─────────────
 * {
 *   detected:            boolean,
 *   likely_change_index: number | null,
 *   method:              string,          — comma-separated signals that fired
 *   confidence:          number           — 0.00 – 1.00
 * }
 *
 * Detection requires a confidence > 0 AND at least one signal to have fired.
 * When no signal discriminates (all outputs equal score) detected = false.
 *
 * Limitations
 * ───────────
 * - Only the two-output case is fully supported.  For ≥3 outputs the signals
 *   still run but change is harder to isolate (confidence will be lower).
 * - Coinbase transactions are skipped immediately.
 * - OP_RETURN outputs are excluded from candidacy.
 *
 * Compatibility with HeuristicEngine
 * ────────────────────────────────────
 * The exported object satisfies { id: string, analyze: (tx, context) → result }.
 *
 * Public API
 * ──────────
 *   changeDetection.id        — 'change_detection'
 *   changeDetection.analyze(tx, context?) → ChangeResult
 */

import { detectScriptType } from '../analysis/scriptTypes.js';
import { isCoinbase }       from './cioh.js';

// ── Signal weights ────────────────────────────────────────────────────────────

const W_SCRIPT_MATCH = 1.0;
const W_SMALLER      = 0.5;
const W_NON_ROUND    = 1.0;
const MAX_SCORE      = W_SCRIPT_MATCH + W_SMALLER + W_NON_ROUND; // 2.5

// Round-value thresholds (ascending order; first match wins)
const ROUND_CADENCES = [10_000, 100_000, 1_000_000];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Determine the *majority* script type among the transaction's inputs.
 * Uses the `scriptPubKey` field on each prevout when available; falls back
 * to inspecting the input's `scriptSig` hex as a rough proxy for legacy
 * inputs.  When no type can be determined returns null.
 *
 * In practice callers pass context.prevouts (array of { script_pubkey })
 * which is the authoritative source.
 *
 * @param {object[]} vin
 * @param {object[]} [prevouts]
 * @returns {string|null}
 */
function majorityInputScriptType(vin, prevouts) {
    const counts = new Map();

    for (let i = 0; i < vin.length; i++) {
        const spk = prevouts?.[i]?.script_pubkey ?? prevouts?.[i]?.scriptPubKey;
        if (!spk) continue;
        try {
            const t = detectScriptType(spk);
            if (t !== 'unknown' && t !== 'op_return') {
                counts.set(t, (counts.get(t) ?? 0) + 1);
            }
        } catch {
            // ignore undetectable prevout scripts
        }
    }

    if (counts.size === 0) return null;
    return [...counts.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
}

/**
 * Return true when `value` is a multiple of any cadence in ROUND_CADENCES.
 *
 * @param {number} value  Satoshi amount.
 * @returns {boolean}
 */
function isRoundValue(value) {
    return ROUND_CADENCES.some(c => value % c === 0);
}

// ── Heuristic ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ChangeResult
 * @property {boolean}     detected
 * @property {number|null} likely_change_index
 * @property {string}      method      — comma-separated signal names that fired
 * @property {number}      confidence  — 0.00 – 1.00
 */

export const changeDetection = {
    id: 'change_detection',

    /**
     * @param {object} tx
     * @param {{ prevouts?: Array<{ script_pubkey?: string }> }} [context]
     * @returns {ChangeResult}
     */
    analyze(tx, context = {}) {
        const notDetected = { detected: false, likely_change_index: null, method: '', confidence: 0 };

        if (isCoinbase(tx)) return notDetected;

        const outputs = Array.isArray(tx?.vout) ? tx.vout : [];

        // Filter out OP_RETURN outputs — they can never be change
        const candidates = outputs
            .map((o, i) => ({ index: i, value: o.value_sats, scriptPubKey: o.scriptPubKey }))
            .filter(o => {
                try { return detectScriptType(o.scriptPubKey) !== 'op_return'; }
                catch { return true; }
            });

        if (candidates.length < 2) return notDetected;

        // Initialise per-output score accumulators
        const scores  = new Array(candidates.length).fill(0);
        const signals = new Array(candidates.length).fill(null).map(() => new Set());

        // ── Signal 1: script-type match ───────────────────────────────────────
        const inputType = majorityInputScriptType(
            Array.isArray(tx.vin) ? tx.vin : [],
            context.prevouts
        );

        if (inputType) {
            for (let i = 0; i < candidates.length; i++) {
                try {
                    if (detectScriptType(candidates[i].scriptPubKey) === inputType) {
                        scores[i]  += W_SCRIPT_MATCH;
                        signals[i].add('script_type_match');
                    }
                } catch { /* skip */ }
            }
        }

        // ── Signal 2: smaller value ───────────────────────────────────────────
        // Only meaningful for the 2-output case (otherwise "smaller of N" is weak)
        if (candidates.length === 2) {
            const smallerIdx = candidates[0].value <= candidates[1].value ? 0 : 1;
            // Only award the point when values differ; equal outputs are ambiguous.
            if (candidates[0].value !== candidates[1].value) {
                scores[smallerIdx]  += W_SMALLER;
                signals[smallerIdx].add('smaller_value');
            }
        }

        // ── Signal 3: non-round value ─────────────────────────────────────────
        for (let i = 0; i < candidates.length; i++) {
            if (!isRoundValue(candidates[i].value)) {
                scores[i]  += W_NON_ROUND;
                signals[i].add('non_round_value');
            }
        }

        // ── Select winner ─────────────────────────────────────────────────────
        let bestIdx   = 0;
        let bestScore = scores[0];
        for (let i = 1; i < scores.length; i++) {
            if (scores[i] > bestScore) {
                bestScore = scores[i];
                bestIdx   = i;
            }
        }

        // If top two scores are tied, no confident winner
        const secondBest = scores
            .filter((_, i) => i !== bestIdx)
            .reduce((a, b) => Math.max(a, b), -Infinity);

        if (bestScore === secondBest || bestScore === 0) return notDetected;

        const confidence = Math.round((bestScore / MAX_SCORE) * 100) / 100;
        const method     = [...signals[bestIdx]].join(',');

        return {
            detected:            true,
            likely_change_index: candidates[bestIdx].index,
            method,
            confidence,
        };
    },
};
