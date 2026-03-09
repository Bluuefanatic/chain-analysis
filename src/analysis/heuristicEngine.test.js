/**
 * src/analysis/heuristicEngine.test.js
 *
 * Unit tests for heuristicEngine.js using the Node.js built-in test runner.
 *
 * Run single file:  node --test src/analysis/heuristicEngine.test.js
 * Run all tests:    node --test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    HeuristicEngine,
    ciohHeuristic,
    changeDetectionHeuristic,
    createDefaultEngine,
} from './heuristicEngine.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NULL_TXID = '0'.repeat(64);
const DUMMY_TXID = 'ab'.repeat(32);
const DUMMY_SCRIPT = '76a914' + 'aa'.repeat(20) + '88ac';

/** A standard two-input, two-output legacy transaction. */
const TX_MULTI_INPUT = {
    txid: DUMMY_TXID,
    version: 1,
    vin: [
        { prev_txid: DUMMY_TXID, vout: 0, scriptSig: 'dead', sequence: 0xffffffff },
        { prev_txid: DUMMY_TXID, vout: 1, scriptSig: 'beef', sequence: 0xffffffff },
    ],
    vout: [
        { value_sats: 1_000_000, scriptPubKey: DUMMY_SCRIPT }, // round
        { value_sats: 123_456, scriptPubKey: DUMMY_SCRIPT }, // non-round → change
    ],
    locktime: 0, size: 300, segwit: false,
};

/** A single-input, two-output transaction (no CIOH). */
const TX_SINGLE_INPUT = {
    txid: DUMMY_TXID,
    version: 1,
    vin: [{ prev_txid: DUMMY_TXID, vout: 0, scriptSig: 'dead', sequence: 0xffffffff }],
    vout: [
        { value_sats: 500_000, scriptPubKey: DUMMY_SCRIPT }, // round
        { value_sats: 78_901, scriptPubKey: DUMMY_SCRIPT }, // non-round → change
    ],
    locktime: 0, size: 200, segwit: false,
};

/** A coinbase transaction (block reward). */
const TX_COINBASE = {
    txid: 'cc'.repeat(32),
    version: 1,
    vin: [{ prev_txid: NULL_TXID, vout: 0xffffffff, scriptSig: 'aabb', sequence: 0xffffffff }],
    vout: [{ value_sats: 625_000_000, scriptPubKey: DUMMY_SCRIPT }],
    locktime: 0, size: 120, segwit: false,
};

/** All outputs are round — change detection should not trigger. */
const TX_ALL_ROUND = {
    txid: DUMMY_TXID,
    version: 1,
    vin: [{ prev_txid: DUMMY_TXID, vout: 0, scriptSig: '', sequence: 0xffffffff }],
    vout: [
        { value_sats: 1_000_000, scriptPubKey: DUMMY_SCRIPT },
        { value_sats: 2_000_000, scriptPubKey: DUMMY_SCRIPT },
    ],
    locktime: 0, size: 200, segwit: false,
};

/** Two non-round outputs — ambiguous, change detection should not trigger. */
const TX_TWO_NON_ROUND = {
    txid: DUMMY_TXID,
    version: 1,
    vin: [{ prev_txid: DUMMY_TXID, vout: 0, scriptSig: '', sequence: 0xffffffff }],
    vout: [
        { value_sats: 123_456, scriptPubKey: DUMMY_SCRIPT },
        { value_sats: 654_321, scriptPubKey: DUMMY_SCRIPT },
    ],
    locktime: 0, size: 200, segwit: false,
};

// ── Suite 1: HeuristicEngine registration ────────────────────────────────────

describe('HeuristicEngine — registration', () => {
    it('starts with no registered heuristics', () => {
        const engine = new HeuristicEngine();
        assert.deepStrictEqual(engine.heuristicIds, []);
    });

    it('register() adds a heuristic and heuristicIds reflects it', () => {
        const engine = new HeuristicEngine();
        engine.register({ id: 'test', analyze: () => ({ detected: false }) });
        assert.deepStrictEqual(engine.heuristicIds, ['test']);
    });

    it('register() replaces a heuristic with the same id', () => {
        const engine = new HeuristicEngine();
        engine.register({ id: 'alpha', analyze: () => ({ detected: false, v: 1 }) });
        engine.register({ id: 'alpha', analyze: () => ({ detected: true, v: 2 }) });
        assert.strictEqual(engine.heuristicIds.length, 1);
        const report = engine.analyzeTransaction({});
        assert.strictEqual(report.alpha.v, 2);
    });

    it('unregister() removes a heuristic', () => {
        const engine = new HeuristicEngine();
        engine.register({ id: 'x', analyze: () => ({}) });
        engine.unregister('x');
        assert.deepStrictEqual(engine.heuristicIds, []);
    });

    it('unregister() silently ignores an unknown id', () => {
        const engine = new HeuristicEngine();
        assert.doesNotThrow(() => engine.unregister('does-not-exist'));
    });

    it('register() throws TypeError when id is missing', () => {
        const engine = new HeuristicEngine();
        assert.throws(
            () => engine.register({ analyze: () => ({}) }),
            /TypeError|non-empty string id/i
        );
    });

    it('register() throws TypeError when id is an empty string', () => {
        const engine = new HeuristicEngine();
        assert.throws(
            () => engine.register({ id: '', analyze: () => ({}) }),
            /TypeError|non-empty string id/i
        );
    });

    it('register() throws TypeError when analyze is not a function', () => {
        const engine = new HeuristicEngine();
        assert.throws(
            () => engine.register({ id: 'bad', analyze: 'nope' }),
            /TypeError|analyze function/i
        );
    });
});

// ── Suite 2: Pipeline execution ───────────────────────────────────────────────

describe('HeuristicEngine — pipeline execution', () => {
    it('analyzeTransaction returns an empty object when no heuristics are registered', () => {
        const engine = new HeuristicEngine();
        assert.deepStrictEqual(engine.analyzeTransaction(TX_SINGLE_INPUT), {});
    });

    it('report keys match registered heuristic ids', () => {
        const engine = new HeuristicEngine();
        engine.register({ id: 'foo', analyze: () => ({ detected: true }) });
        engine.register({ id: 'bar', analyze: () => ({ detected: false }) });
        const report = engine.analyzeTransaction(TX_SINGLE_INPUT);
        assert.ok('foo' in report);
        assert.ok('bar' in report);
        assert.strictEqual(Object.keys(report).length, 2);
    });

    it('heuristic receives the tx argument', () => {
        const engine = new HeuristicEngine();
        let received = null;
        engine.register({ id: 'spy', analyze: (tx) => { received = tx; return {}; } });
        engine.analyzeTransaction(TX_MULTI_INPUT);
        assert.strictEqual(received, TX_MULTI_INPUT);
    });

    it('heuristic receives the context argument', () => {
        const engine = new HeuristicEngine();
        const ctx = { block_height: 850_000 };
        let receivedCtx = null;
        engine.register({ id: 'spy', analyze: (_, c) => { receivedCtx = c; return {}; } });
        engine.analyzeTransaction(TX_MULTI_INPUT, ctx);
        assert.strictEqual(receivedCtx, ctx);
    });

    it('context defaults to {} when omitted', () => {
        const engine = new HeuristicEngine();
        let receivedCtx = null;
        engine.register({ id: 'spy', analyze: (_, c) => { receivedCtx = c; return {}; } });
        engine.analyzeTransaction(TX_MULTI_INPUT);
        assert.deepStrictEqual(receivedCtx, {});
    });

    it('a throwing heuristic yields detected:false with an error field', () => {
        const engine = new HeuristicEngine();
        engine.register({
            id: 'boom',
            analyze: () => { throw new Error('something went wrong'); },
        });
        const report = engine.analyzeTransaction(TX_SINGLE_INPUT);
        assert.strictEqual(report.boom.detected, false);
        assert.match(report.boom.error, /something went wrong/);
    });

    it('a throwing heuristic does not abort subsequent heuristics', () => {
        const engine = new HeuristicEngine();
        engine.register({ id: 'boom', analyze: () => { throw new Error('oops'); } });
        engine.register({ id: 'ok', analyze: () => ({ detected: true }) });
        const report = engine.analyzeTransaction(TX_SINGLE_INPUT);
        assert.strictEqual(report.ok.detected, true);
    });

    it('heuristics run in registration order', () => {
        const engine = new HeuristicEngine();
        const order = [];
        engine.register({ id: 'first', analyze: () => { order.push('first'); return {}; } });
        engine.register({ id: 'second', analyze: () => { order.push('second'); return {}; } });
        engine.register({ id: 'third', analyze: () => { order.push('third'); return {}; } });
        engine.analyzeTransaction({});
        assert.deepStrictEqual(order, ['first', 'second', 'third']);
    });
});

// ── Suite 3: Built-in — CIOH heuristic ───────────────────────────────────────

describe('ciohHeuristic', () => {
    it('detects multi-input transaction', () => {
        const r = ciohHeuristic.analyze(TX_MULTI_INPUT);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.input_count, 2);
    });

    it('does not detect single-input transaction', () => {
        const r = ciohHeuristic.analyze(TX_SINGLE_INPUT);
        assert.strictEqual(r.detected, false);
        assert.strictEqual(r.input_count, 1);
    });

    it('does not detect coinbase (single null-hash input)', () => {
        const r = ciohHeuristic.analyze(TX_COINBASE);
        assert.strictEqual(r.detected, false);
    });

    it('detects a 3-input transaction', () => {
        const tx3 = {
            vin: [
                { prev_txid: DUMMY_TXID, vout: 0 },
                { prev_txid: DUMMY_TXID, vout: 1 },
                { prev_txid: DUMMY_TXID, vout: 2 },
            ],
            vout: [],
        };
        const r = ciohHeuristic.analyze(tx3);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.input_count, 3);
    });
});

// ── Suite 4: Built-in — change detection heuristic ───────────────────────────

describe('changeDetectionHeuristic', () => {
    it('detects change when exactly one output is non-round', () => {
        const r = changeDetectionHeuristic.analyze(TX_MULTI_INPUT);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.change_output_index, 1);   // 123_456 sat
        assert.strictEqual(r.round_unit_sats, 100_000);
    });

    it('does not detect change when all outputs are round', () => {
        const r = changeDetectionHeuristic.analyze(TX_ALL_ROUND);
        assert.strictEqual(r.detected, false);
        assert.strictEqual(r.change_output_index, null);
    });

    it('does not detect change when two outputs are non-round (ambiguous)', () => {
        const r = changeDetectionHeuristic.analyze(TX_TWO_NON_ROUND);
        assert.strictEqual(r.detected, false);
        assert.strictEqual(r.change_output_index, null);
    });

    it('respects round_unit_sats from context', () => {
        // With unit = 1_000_000, only 1_000_000 sat is round; 123_456 is not.
        const r = changeDetectionHeuristic.analyze(TX_MULTI_INPUT, { round_unit_sats: 1_000_000 });
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.change_output_index, 1);
        assert.strictEqual(r.round_unit_sats, 1_000_000);
    });

    it('handles a transaction with no outputs', () => {
        const tx = { vin: [], vout: [] };
        const r = changeDetectionHeuristic.analyze(tx);
        assert.strictEqual(r.detected, false);
        assert.strictEqual(r.change_output_index, null);
    });
});

// ── Suite 5: createDefaultEngine integration ──────────────────────────────────

describe('createDefaultEngine', () => {
    it('registers cioh and change_detection', () => {
        const engine = createDefaultEngine();
        assert.ok(engine.heuristicIds.includes('cioh'));
        assert.ok(engine.heuristicIds.includes('change_detection'));
    });

    it('report has both keys for a multi-input transaction', () => {
        const engine = createDefaultEngine();
        const report = engine.analyzeTransaction(TX_MULTI_INPUT);
        assert.ok('cioh' in report);
        assert.ok('change_detection' in report);
    });

    it('cioh detects multi-input in full pipeline', () => {
        const engine = createDefaultEngine();
        assert.strictEqual(engine.analyzeTransaction(TX_MULTI_INPUT).cioh.detected, true);
    });

    it('change_detection detects change in full pipeline', () => {
        const engine = createDefaultEngine();
        assert.strictEqual(
            engine.analyzeTransaction(TX_MULTI_INPUT).change_detection.detected,
            true
        );
    });

    it('neither heuristic detects on a coinbase transaction', () => {
        const engine = createDefaultEngine();
        const report = engine.analyzeTransaction(TX_COINBASE);
        assert.strictEqual(report.cioh.detected, false);
        assert.strictEqual(report.change_detection.detected, false);
    });

    it('result shape matches the documented format', () => {
        const engine = createDefaultEngine();
        const report = engine.analyzeTransaction(TX_MULTI_INPUT);
        // Verify the shape: { cioh: { detected: bool }, change_detection: { detected: bool } }
        assert.strictEqual(typeof report.cioh.detected, 'boolean');
        assert.strictEqual(typeof report.change_detection.detected, 'boolean');
    });
});
