/**
 * src/heuristics/cioh.test.js
 *
 * Unit tests for cioh.js.
 *
 * Run:  node --test src/heuristics/cioh.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cioh, isCoinbase } from './cioh.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NULL_TXID = '0'.repeat(64);
const DUMMY_TXID = 'ab'.repeat(32);

function makeVin(count) {
    return Array.from({ length: count }, (_, i) => ({
        prev_txid: DUMMY_TXID,
        vout: i,
        scriptSig: 'dead',
        sequence: 0xffffffff,
    }));
}

const TX_0_INPUTS = { vin: [] };
const TX_1_INPUT = { vin: makeVin(1) };
const TX_2_INPUTS = { vin: makeVin(2) };
const TX_3_INPUTS = { vin: makeVin(3) };
const TX_10_INPUTS = { vin: makeVin(10) };

const TX_COINBASE = {
    vin: [{ prev_txid: NULL_TXID, vout: 0xffffffff, scriptSig: 'aabb', sequence: 0xffffffff }],
};

// ── isCoinbase helper ─────────────────────────────────────────────────────────

describe('isCoinbase', () => {
    it('returns true for a canonical coinbase input', () => {
        assert.strictEqual(isCoinbase(TX_COINBASE), true);
    });

    it('returns false for a regular single-input tx', () => {
        assert.strictEqual(isCoinbase(TX_1_INPUT), false);
    });

    it('returns false for a multi-input tx', () => {
        assert.strictEqual(isCoinbase(TX_2_INPUTS), false);
    });

    it('returns false when tx has no vin', () => {
        assert.strictEqual(isCoinbase({}), false);
    });

    it('returns false for 2-input tx even if first input is null-hash', () => {
        const tx = {
            vin: [
                { prev_txid: NULL_TXID, vout: 0xffffffff },
                { prev_txid: DUMMY_TXID, vout: 0 },
            ],
        };
        assert.strictEqual(isCoinbase(tx), false);
    });
});

// ── cioh.analyze ─────────────────────────────────────────────────────────────

describe('cioh.analyze — id', () => {
    it('has id "cioh"', () => {
        assert.strictEqual(cioh.id, 'cioh');
    });
});

describe('cioh.analyze — non-detection cases', () => {
    it('not detected for 0 inputs', () => {
        const r = cioh.analyze(TX_0_INPUTS);
        assert.strictEqual(r.detected, false);
        assert.strictEqual(r.input_count, 0);
        assert.strictEqual(r.confidence, 0.0);
    });

    it('not detected for 1 input', () => {
        const r = cioh.analyze(TX_1_INPUT);
        assert.strictEqual(r.detected, false);
        assert.strictEqual(r.input_count, 1);
        assert.strictEqual(r.confidence, 0.0);
    });

    it('not detected for a coinbase transaction', () => {
        const r = cioh.analyze(TX_COINBASE);
        assert.strictEqual(r.detected, false);
        assert.strictEqual(r.confidence, 0.0);
    });
});

describe('cioh.analyze — detection cases', () => {
    it('detected for 2 inputs', () => {
        const r = cioh.analyze(TX_2_INPUTS);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.input_count, 2);
    });

    it('detected for 3 inputs', () => {
        const r = cioh.analyze(TX_3_INPUTS);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.input_count, 3);
    });

    it('detected for 10 inputs', () => {
        const r = cioh.analyze(TX_10_INPUTS);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.input_count, 10);
    });
});

describe('cioh.analyze — confidence model', () => {
    it('confidence is 0 when not detected', () => {
        assert.strictEqual(cioh.analyze(TX_1_INPUT).confidence, 0.0);
    });

    it('confidence for 2 inputs is close to 0.9 (base)', () => {
        const { confidence } = cioh.analyze(TX_2_INPUTS);
        assert.ok(confidence >= 0.88 && confidence <= 0.90,
            `expected ~0.90, got ${confidence}`);
    });

    it('confidence decreases as input count grows', () => {
        const c2 = cioh.analyze(TX_2_INPUTS).confidence;
        const c3 = cioh.analyze(TX_3_INPUTS).confidence;
        const c10 = cioh.analyze(TX_10_INPUTS).confidence;
        assert.ok(c2 > c3, `2-input confidence (${c2}) should exceed 3-input (${c3})`);
        assert.ok(c3 > c10, `3-input confidence (${c3}) should exceed 10-input (${c10})`);
    });

    it('confidence is in [0, 1]', () => {
        for (const tx of [TX_0_INPUTS, TX_1_INPUT, TX_2_INPUTS, TX_10_INPUTS]) {
            const { confidence } = cioh.analyze(tx);
            assert.ok(confidence >= 0 && confidence <= 1,
                `confidence out of range: ${confidence}`);
        }
    });

    it('confidence is rounded to 3 decimal places', () => {
        const { confidence } = cioh.analyze(TX_3_INPUTS);
        assert.strictEqual(confidence, Math.round(confidence * 1000) / 1000);
    });
});
