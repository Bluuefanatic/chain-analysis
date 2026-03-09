/**
 * src/heuristics/consolidation.test.js
 *
 * Unit tests for consolidation.js.
 *
 * Run:  node --test src/heuristics/consolidation.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { consolidation } from './consolidation.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NULL_TXID = '0'.repeat(64);
const DUMMY_TXID = 'ab'.repeat(32);
const SPK = (n) => '0014' + n.toString(16).padStart(2, '0').repeat(20);

function makeVin(count) {
    return Array.from({ length: count }, (_, i) => ({
        prev_txid: DUMMY_TXID, vout: i, scriptSig: '', sequence: 0xffffffff,
    }));
}

function makeVout(count) {
    return Array.from({ length: count }, (_, i) => ({
        value_sats: 100_000, scriptPubKey: SPK(i + 1),
    }));
}

const COINBASE_TX = {
    vin: [{ prev_txid: NULL_TXID, vout: 0xffffffff, scriptSig: '', sequence: 0xffffffff }],
    vout: makeVout(1),
};

// ── Suite: id ─────────────────────────────────────────────────────────────────

describe('consolidation — id', () => {
    it('has id "consolidation"', () => {
        assert.strictEqual(consolidation.id, 'consolidation');
    });
});

// ── Suite: coinbase skip ───────────────────────────────────────────────────────

describe('consolidation — coinbase skip', () => {
    it('returns detected:false for coinbase', () => {
        const r = consolidation.analyze(COINBASE_TX);
        assert.strictEqual(r.detected, false);
    });
});

// ── Suite: non-detection ───────────────────────────────────────────────────────

describe('consolidation — non-detection', () => {
    it('not detected for a typical 2-in / 2-out spend (ratio 1.0)', () => {
        const tx = { vin: makeVin(2), vout: makeVout(2) };
        const r = consolidation.analyze(tx);
        assert.strictEqual(r.detected, false);
        assert.strictEqual(r.ratio, 1);
    });

    it('not detected for 2-in / 1-out (ratio 2.0, below threshold)', () => {
        const tx = { vin: makeVin(2), vout: makeVout(1) };
        assert.strictEqual(consolidation.analyze(tx).detected, false);
    });

    it('not detected for 3-in / 2-out (ratio 1.5)', () => {
        const tx = { vin: makeVin(3), vout: makeVout(2) };
        assert.strictEqual(consolidation.analyze(tx).detected, false);
    });

    it('not detected when input count is below MIN_INPUTS (2 inputs)', () => {
        // ratio would be 2.0 which is below threshold anyway; also < min inputs
        const tx = { vin: makeVin(2), vout: makeVout(1) };
        assert.strictEqual(consolidation.analyze(tx).detected, false);
    });

    it('returns detected:false when there are no outputs', () => {
        const tx = { vin: makeVin(5), vout: [] };
        assert.strictEqual(consolidation.analyze(tx).detected, false);
    });
});

// ── Suite: detection ──────────────────────────────────────────────────────────

describe('consolidation — detection', () => {
    it('detected for 3-in / 1-out (ratio 3.0, at threshold)', () => {
        const tx = { vin: makeVin(3), vout: makeVout(1) };
        const r = consolidation.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.input_count, 3);
        assert.strictEqual(r.output_count, 1);
        assert.strictEqual(r.ratio, 3);
    });

    it('detected for 6-in / 1-out (ratio 6.0)', () => {
        const tx = { vin: makeVin(6), vout: makeVout(1) };
        const r = consolidation.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.ratio, 6);
    });

    it('detected for 9-in / 3-out (ratio 3.0)', () => {
        const tx = { vin: makeVin(9), vout: makeVout(3) };
        const r = consolidation.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.input_count, 9);
        assert.strictEqual(r.output_count, 3);
        assert.strictEqual(r.ratio, 3);
    });

    it('detected for 10-in / 2-out (ratio 5.0)', () => {
        const tx = { vin: makeVin(10), vout: makeVout(2) };
        const r = consolidation.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.ratio, 5);
    });
});

// ── Suite: ratio rounding ─────────────────────────────────────────────────────

describe('consolidation — ratio precision', () => {
    it('ratio is rounded to 2 decimal places', () => {
        // 10-in / 3-out = 3.333... → 3.33
        const tx = { vin: makeVin(10), vout: makeVout(3) };
        const r = consolidation.analyze(tx);
        assert.strictEqual(r.ratio, 3.33);
    });
});
