/**
 * src/analysis/heuristicEngine.js
 *
 * A plugin-based heuristic engine for Bitcoin transaction analysis.
 *
 * Architecture
 * ────────────
 * A heuristic is any object that satisfies the Heuristic interface:
 *
 *   {
 *     id:      string                    — unique, kebab-case identifier
 *     analyze: (tx, context) → Result   — pure function; must not throw
 *   }
 *
 * The engine maintains an ordered registry of heuristics.  When
 * analyzeTransaction() is called each heuristic runs in registration order
 * and its result is keyed by id in the returned report object.
 *
 * Context
 * ───────
 * An optional `context` object is forwarded to every heuristic unchanged.
 * It can carry block-level data (block height, fee rates, prevout map, etc.)
 * that individual heuristics may need but that is not part of the raw tx.
 *
 * Error isolation
 * ───────────────
 * If a heuristic throws, the engine records { detected: false, error: message }
 * and continues with the remaining heuristics so one bad plugin can never
 * abort the pipeline.
 *
 * Built-in heuristics (registered automatically in the default export)
 * ─────────────────────────────────────────────────────────────────────
 *   cioh            — Common-Input-Ownership Heuristic
 *   change_detection — Round-value change-output detection
 *
 * Public API
 * ──────────
 *   class HeuristicEngine
 *     constructor()
 *     register(heuristic)              — add (or replace) a heuristic
 *     unregister(id)                   — remove a heuristic by id
 *     analyzeTransaction(tx, context?) — run the full pipeline; return report
 *     get heuristicIds                 — ordered snapshot of registered ids
 *
 *   createDefaultEngine()  — factory that returns an engine pre-loaded with
 *                            the built-in heuristics
 */

// ── Engine ────────────────────────────────────────────────────────────────────

export class HeuristicEngine {
    /** @type {Map<string, { id: string, analyze: Function }>} */
    #registry = new Map();

    /**
     * Register a heuristic.  If a heuristic with the same id is already
     * registered it is replaced in-place (preserving insertion order).
     *
     * @param {{ id: string, analyze: (tx: object, context?: object) => object }} heuristic
     * @throws {TypeError} When the heuristic does not satisfy the interface.
     */
    register(heuristic) {
        if (
            !heuristic ||
            typeof heuristic.id !== 'string' ||
            heuristic.id.trim() === '' ||
            typeof heuristic.analyze !== 'function'
        ) {
            throw new TypeError(
                'HeuristicEngine.register: heuristic must have a non-empty string id ' +
                'and an analyze function'
            );
        }
        this.#registry.set(heuristic.id, heuristic);
    }

    /**
     * Remove a previously registered heuristic.
     * Silently does nothing when the id is not found.
     *
     * @param {string} id
     */
    unregister(id) {
        this.#registry.delete(id);
    }

    /**
     * Snapshot of currently registered heuristic ids in insertion order.
     * @returns {string[]}
     */
    get heuristicIds() {
        return [...this.#registry.keys()];
    }

    /**
     * Run every registered heuristic on `tx` and collect results.
     *
     * Each heuristic result is stored under its id.  Heuristics that throw
     * contribute { detected: false, error: <message> } instead of crashing
     * the pipeline.
     *
     * @param {object}  tx           Decoded transaction object.
     * @param {object}  [context={}] Optional block/chain context.
     * @returns {Record<string, object>}  Report keyed by heuristic id.
     */
    analyzeTransaction(tx, context = {}) {
        const report = {};
        for (const heuristic of this.#registry.values()) {
            try {
                report[heuristic.id] = heuristic.analyze(tx, context);
            } catch (err) {
                report[heuristic.id] = {
                    detected: false,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        }
        return report;
    }
}

// ── Built-in heuristics ───────────────────────────────────────────────────────

/**
 * Common-Input-Ownership Heuristic (CIOH)
 *
 * The foundational heuristic from Satoshi's whitepaper (§10): when a
 * transaction has more than one input, those inputs are assumed to be
 * controlled by the same entity (wallet).
 *
 * Detected when: tx has ≥ 2 inputs AND is not a coinbase.
 *
 * Result: { detected: boolean, input_count: number }
 */
export const ciohHeuristic = {
    id: 'cioh',

    /** @param {object} tx */
    analyze(tx) {
        const inputCount = Array.isArray(tx.vin) ? tx.vin.length : 0;
        const isCoinbase =
            inputCount === 1 &&
            tx.vin[0].prev_txid === '0'.repeat(64) &&
            tx.vin[0].vout === 0xffffffff;

        return {
            detected: !isCoinbase && inputCount >= 2,
            input_count: inputCount,
        };
    },
};

/**
 * Round-Value Change Detection Heuristic
 *
 * In most payments the payment amount is round (e.g. 0.01 BTC = 1_000_000 sat)
 * while the change output contains the non-round remainder.  When exactly one
 * output has a value that is NOT a multiple of a round unit (100_000 sat by
 * default) it is likely the change output.
 *
 * Detected when: there is exactly one "non-round" output among all outputs.
 *
 * Result:
 *   { detected: boolean, change_output_index: number|null, round_unit_sats: number }
 *
 * context.round_unit_sats (optional, default 100_000) — threshold for
 * "roundness".  Pass a value appropriate to the payment amount range being
 * analysed.
 */
export const changeDetectionHeuristic = {
    id: 'change_detection',

    /** @param {object} tx  @param {{ round_unit_sats?: number }} [context] */
    analyze(tx, context = {}) {
        const roundUnit = (context.round_unit_sats ?? 100_000);
        const outputs   = Array.isArray(tx.vout) ? tx.vout : [];

        const nonRoundIndices = outputs
            .map((o, i) => ({ i, value: o.value_sats }))
            .filter(({ value }) => value % roundUnit !== 0)
            .map(({ i }) => i);

        const detected = nonRoundIndices.length === 1;
        return {
            detected,
            change_output_index: detected ? nonRoundIndices[0] : null,
            round_unit_sats:     roundUnit,
        };
    },
};

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create a HeuristicEngine pre-loaded with all built-in heuristics.
 *
 * @returns {HeuristicEngine}
 */
export function createDefaultEngine() {
    const engine = new HeuristicEngine();
    engine.register(ciohHeuristic);
    engine.register(changeDetectionHeuristic);
    return engine;
}
