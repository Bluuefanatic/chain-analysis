/**
 * src/heuristics/addressReuse.js
 *
 * Address-Reuse Detection Heuristic
 *
 * Background
 * ──────────
 * Address reuse occurs when the same scriptPubKey (address) appears in both
 * the spending inputs (via prevouts) AND in the outputs of the same
 * transaction.  This is a strong privacy leak: it reveals that the sender
 * controlled the address previously and is sending change back to it.
 *
 * Detection criteria
 * ──────────────────
 * A reuse is detected when at least one output scriptPubKey matches a
 * scriptPubKey from any of the transaction's resolved prevouts.
 *
 * context.prevouts  — Array<{ script_pubkey: string }>  (one per input, in order)
 *                     Required for detection; without it the result is always
 *                     detected:false.
 *
 * Output
 * ──────
 * {
 *   detected:       boolean,
 *   reused_indices: number[]   — output indices where reuse was found
 * }
 *
 * Compatibility with HeuristicEngine
 * ────────────────────────────────────
 * Satisfies { id: string, analyze: (tx, context) → result }.
 */

import { isCoinbase } from './cioh.js';

export const addressReuse = {
    id: 'address_reuse',

    /**
     * @param {object} tx
     * @param {{ prevouts?: Array<{ script_pubkey?: string }> }} [context]
     * @returns {{ detected: boolean, reused_indices: number[] }}
     */
    analyze(tx, context = {}) {
        if (isCoinbase(tx)) return { detected: false, reused_indices: [] };

        const prevouts = Array.isArray(context.prevouts) ? context.prevouts : [];
        if (prevouts.length === 0) return { detected: false, reused_indices: [] };

        // Build a set of input script pubkeys (normalised to lowercase)
        const inputScripts = new Set(
            prevouts
                .map(p => (p?.script_pubkey ?? p?.scriptPubKey ?? '').toLowerCase())
                .filter(s => s.length > 0)
        );

        const outputs = Array.isArray(tx?.vout) ? tx.vout : [];
        const reusedIndices = [];

        for (let i = 0; i < outputs.length; i++) {
            const spk = (outputs[i]?.scriptPubKey ?? '').toLowerCase();
            if (spk.length > 0 && inputScripts.has(spk)) {
                reusedIndices.push(i);
            }
        }

        return {
            detected:       reusedIndices.length > 0,
            reused_indices: reusedIndices,
        };
    },
};
