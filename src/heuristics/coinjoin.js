/**
 * src/heuristics/coinjoin.js
 *
 * CoinJoin Detection Heuristic
 *
 * Background
 * ──────────
 * A CoinJoin is a collaborative transaction where multiple independent parties
 * combine their inputs into a single transaction whose outputs include several
 * equal-value amounts.  The equal outputs make it difficult for an observer to
 * link a specific input to a specific output, improving privacy.
 *
 * Detection criteria (Möser / Wasabi heuristic)
 * ──────────────────────────────────────────────
 * A transaction is flagged as a likely CoinJoin when ALL of the following hold:
 *
 *   1. ≥ 2 inputs  (collaborative spend)
 *   2. ≥ 2 equal-value outputs  (the "mixed" denomination outputs)
 *   3. The equal denomination is ≥ MIN_DENOMINATION_SATS (default 10 000 sat)
 *      to exclude dust-level coincidences
 *
 * These are necessary but not sufficient conditions.  Real-world CoinJoin
 * detection additionally examines witness structure and script types, but
 * those require prevout data beyond the scope of this module.
 *
 * Output
 * ──────
 * {
 *   detected:        boolean,
 *   equal_output_count: number,   — how many outputs share the dominant value
 *   denomination_sats:  number    — the shared denomination (0 when not detected)
 * }
 *
 * Compatibility with HeuristicEngine
 * ────────────────────────────────────
 * Satisfies { id: string, analyze: (tx, context) → result }.
 */

import { isCoinbase } from './cioh.js';

const MIN_DENOMINATION_SATS = 10_000;

export const coinjoin = {
    id: 'coinjoin',

    /**
     * @param {object} tx
     * @returns {{ detected: boolean, equal_output_count: number, denomination_sats: number }}
     */
    analyze(tx) {
        if (isCoinbase(tx)) {
            return { detected: false, equal_output_count: 0, denomination_sats: 0 };
        }

        const vin  = Array.isArray(tx?.vin)  ? tx.vin  : [];
        const vout = Array.isArray(tx?.vout) ? tx.vout : [];

        if (vin.length < 2) {
            return { detected: false, equal_output_count: 0, denomination_sats: 0 };
        }

        // Count occurrences of each output value
        const valueCounts = new Map();
        for (const output of vout) {
            const v = output.value_sats;
            valueCounts.set(v, (valueCounts.get(v) ?? 0) + 1);
        }

        // Find the value with the highest count that also meets the minimum denomination
        let bestDenomination = 0;
        let bestCount        = 0;

        for (const [value, count] of valueCounts) {
            if (count >= 2 && value >= MIN_DENOMINATION_SATS && count > bestCount) {
                bestDenomination = value;
                bestCount        = count;
            }
        }

        if (bestCount < 2) {
            return { detected: false, equal_output_count: 0, denomination_sats: 0 };
        }

        return {
            detected:           true,
            equal_output_count: bestCount,
            denomination_sats:  bestDenomination,
        };
    },
};
