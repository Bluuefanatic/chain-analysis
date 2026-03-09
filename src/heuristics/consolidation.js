/**
 * src/heuristics/consolidation.js
 *
 * Input-Consolidation Detection Heuristic
 *
 * Background
 * ──────────
 * A consolidation transaction is one where a wallet sweeps many UTXOs into
 * a single (or very few) outputs.  Users consolidate during periods of low
 * fees to reduce future transaction costs.  From a chain-analysis perspective
 * consolidations are highly informative: they strongly link all spending
 * inputs to a single entity and reveal the wallet's UTXO set size.
 *
 * Detection criteria
 * ──────────────────
 * A transaction is classified as a consolidation when:
 *
 *   input_count / output_count  ≥  CONSOLIDATION_RATIO  (default 3.0)
 *   AND input_count             ≥  MIN_INPUTS            (default 3)
 *
 * Rationale for the ratio threshold:
 *   - A typical 2-in / 1-out spend already has ratio 2.0 and is not
 *     necessarily a consolidation (it might just be paying with change).
 *   - A ratio of 3+ with at least 3 inputs is a much stronger signal.
 *   - Coinbase transactions are excluded.
 *
 * Output
 * ──────
 * {
 *   detected:      boolean,
 *   input_count:   number,
 *   output_count:  number,
 *   ratio:         number   — input_count / output_count (rounded to 2 d.p.)
 * }
 *
 * Compatibility with HeuristicEngine
 * ────────────────────────────────────
 * Satisfies { id: string, analyze: (tx, context) → result }.
 */

import { isCoinbase } from './cioh.js';

const CONSOLIDATION_RATIO = 3.0;
const MIN_INPUTS = 3;

export const consolidation = {
    id: 'consolidation',

    /**
     * @param {object} tx
     * @returns {{ detected: boolean, input_count: number, output_count: number, ratio: number }}
     */
    analyze(tx) {
        if (isCoinbase(tx)) {
            return { detected: false, input_count: 1, output_count: 0, ratio: 0 };
        }

        const inputCount = Array.isArray(tx?.vin) ? tx.vin.length : 0;
        const outputCount = Array.isArray(tx?.vout) ? tx.vout.length : 0;

        if (outputCount === 0) {
            return { detected: false, input_count: inputCount, output_count: 0, ratio: 0 };
        }

        const ratio = Math.round((inputCount / outputCount) * 100) / 100;

        const detected =
            inputCount >= MIN_INPUTS &&
            ratio >= CONSOLIDATION_RATIO;

        return { detected, input_count: inputCount, output_count: outputCount, ratio };
    },
};
