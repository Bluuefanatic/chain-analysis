/**
 * src/analysis/classifier.js
 *
 * Transaction Classification
 *
 * Derives a single human-readable label from a transaction and its heuristic
 * results.  The classifier consumes the same `{ tx, context }` pair used by
 * the heuristic engine and runs any heuristics it needs internally, so callers
 * do not need to pre-compute results.
 *
 * Classifications (mutually exclusive, priority ordered)
 * ──────────────────────────────────────────────────────
 *   coinjoin        — CoinJoin / collaborative mix detected
 *   consolidation   — High input-to-output ratio sweep
 *   batch_payment   — Single sender paying multiple recipients (≥3 outputs
 *                     where no coinjoin/consolidation applies)
 *   self_transfer   — All output scripts match input scripts (no net payment)
 *   simple_payment  — 1- or 2-input, 1- or 2-output ordinary spend
 *   unknown         — Anything that does not fit the above
 *
 * Decision tree (evaluated top to bottom; first match wins)
 * ──────────────────────────────────────────────────────────
 *   1. coinjoin      if coinjoin.detected
 *   2. consolidation if consolidation.detected
 *   3. batch_payment if output_count ≥ 3  (and not coinjoin/consolidation)
 *   4. self_transfer if every spendable output script appears in the prevout
 *                    script set  (requires context.prevouts)
 *   5. simple_payment if input_count ≤ 2 AND output_count ≤ 2
 *   6. unknown       otherwise
 *
 * Coinbase transactions are labelled 'unknown' since they are not payments.
 *
 * Public API
 * ──────────
 *   classifyTransaction(tx, context?) → ClassificationResult
 *
 *   ClassificationResult:
 *   {
 *     classification: string,   — one of the six labels above
 *     heuristics:     object    — raw heuristic results used in the decision
 *   }
 */

import { isCoinbase }        from '../heuristics/cioh.js';
import { coinjoin }          from '../heuristics/coinjoin.js';
import { consolidation }     from '../heuristics/consolidation.js';
import { addressReuse }      from '../heuristics/addressReuse.js';
import { detectScriptType }  from './scriptTypes.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Return true when every spendable (non-OP_RETURN) output scriptPubKey
 * exists in the set of input prevout scripts.
 *
 * @param {object[]} vout     Output array from the decoded tx.
 * @param {Set<string>} inputScriptSet  Normalised input script pubkeys.
 * @returns {boolean}
 */
function allOutputsInInputSet(vout, inputScriptSet) {
    if (inputScriptSet.size === 0) return false;
    const spendable = vout.filter(o => {
        try { return detectScriptType(o.scriptPubKey ?? '') !== 'op_return'; }
        catch { return true; }
    });
    if (spendable.length === 0) return false;
    return spendable.every(o =>
        inputScriptSet.has((o.scriptPubKey ?? '').toLowerCase())
    );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * @typedef {'coinjoin'|'consolidation'|'batch_payment'|'self_transfer'|'simple_payment'|'unknown'} Classification
 */

/**
 * @typedef {Object} ClassificationResult
 * @property {Classification} classification
 * @property {object}         heuristics  Raw results from each heuristic used.
 */

/**
 * Classify a decoded Bitcoin transaction.
 *
 * @param {object} tx
 * @param {{ prevouts?: Array<{ script_pubkey?: string }> }} [context]
 * @returns {ClassificationResult}
 */
export function classifyTransaction(tx, context = {}) {
    // Coinbase transactions are not classifiable as payments
    if (isCoinbase(tx)) {
        return { classification: 'unknown', heuristics: {} };
    }

    const vin  = Array.isArray(tx?.vin)  ? tx.vin  : [];
    const vout = Array.isArray(tx?.vout) ? tx.vout : [];

    // Run heuristics
    const coinjoinResult      = coinjoin.analyze(tx);
    const consolidationResult = consolidation.analyze(tx);
    const addressReuseResult  = addressReuse.analyze(tx, context);

    const heuristics = {
        coinjoin:      coinjoinResult,
        consolidation: consolidationResult,
        address_reuse: addressReuseResult,
    };

    const inputCount  = vin.length;
    const outputCount = vout.length;

    // ── 1. CoinJoin ───────────────────────────────────────────────────────────
    if (coinjoinResult.detected) {
        return { classification: 'coinjoin', heuristics };
    }

    // ── 2. Consolidation ──────────────────────────────────────────────────────
    if (consolidationResult.detected) {
        return { classification: 'consolidation', heuristics };
    }

    // ── 3. Batch payment ──────────────────────────────────────────────────────
    if (outputCount >= 3) {
        return { classification: 'batch_payment', heuristics };
    }

    // ── 4. Self-transfer ──────────────────────────────────────────────────────
    // Build the set of input scripts from prevouts for the self-transfer check.
    const prevouts    = Array.isArray(context.prevouts) ? context.prevouts : [];
    const inputScripts = new Set(
        prevouts
            .map(p => ((p?.script_pubkey ?? p?.scriptPubKey) ?? '').toLowerCase())
            .filter(s => s.length > 0)
    );

    if (allOutputsInInputSet(vout, inputScripts)) {
        return { classification: 'self_transfer', heuristics };
    }

    // ── 5. Simple payment ─────────────────────────────────────────────────────
    if (inputCount <= 2 && outputCount <= 2) {
        return { classification: 'simple_payment', heuristics };
    }

    // ── 6. Fallback ───────────────────────────────────────────────────────────
    return { classification: 'unknown', heuristics };
}
