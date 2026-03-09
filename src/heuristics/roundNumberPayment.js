/**
 * src/heuristics/roundNumberPayment.js
 *
 * Round-Number Payment Detection Heuristic
 *
 * Background
 * ──────────
 * When a user makes a payment they typically enter a round amount
 * (e.g. 0.01 BTC, 0.1 BTC, 1 BTC).  At least one output of the transaction
 * will therefore be a round number while any change output will be irregular.
 * Identifying the round-number output pinpoints the payment destination and
 * the non-round output as change.
 *
 * Detection criteria
 * ──────────────────
 * A transaction is flagged when at least one output value is divisible by one
 * of the recognised round cadences:
 *
 *   Cadence        Typical use
 *   ─────────────  ─────────────────────────────
 *   1 000 000      0.01 BTC (smallest common unit shown in wallets)
 *   10 000 000     0.1 BTC
 *   100 000 000    1 BTC
 *   500 000 000    5 BTC (less common but real)
 *
 * Only non-zero values are considered.  Coinbase transactions are excluded.
 *
 * Output
 * ──────
 * {
 *   detected:        boolean,
 *   payment_indices: number[],  — indices of outputs matching a round cadence
 *   cadence_sats:    number     — the smallest cadence that triggered (0 if none)
 * }
 *
 * Compatibility with HeuristicEngine
 * ────────────────────────────────────
 * Satisfies { id: string, analyze: (tx, context) → result }.
 */

import { isCoinbase } from './cioh.js';

// Ordered from smallest to largest so we report the most granular match first
const ROUND_CADENCES = [1_000_000, 10_000_000, 100_000_000, 500_000_000];

export const roundNumberPayment = {
    id: 'round_number_payment',

    /**
     * @param {object} tx
     * @returns {{ detected: boolean, payment_indices: number[], cadence_sats: number }}
     */
    analyze(tx) {
        if (isCoinbase(tx)) {
            return { detected: false, payment_indices: [], cadence_sats: 0 };
        }

        const outputs = Array.isArray(tx?.vout) ? tx.vout : [];

        const paymentIndices = [];
        let   smallestCadence = Infinity;

        for (let i = 0; i < outputs.length; i++) {
            const value = outputs[i].value_sats;
            if (!value || value === 0) continue; // skip zero-value outputs

            for (const cadence of ROUND_CADENCES) {
                if (value % cadence === 0) {
                    paymentIndices.push(i);
                    if (cadence < smallestCadence) smallestCadence = cadence;
                    break; // a single cadence match per output is enough
                }
            }
        }

        const detected = paymentIndices.length > 0;
        return {
            detected,
            payment_indices: paymentIndices,
            cadence_sats:    detected ? smallestCadence : 0,
        };
    },
};
