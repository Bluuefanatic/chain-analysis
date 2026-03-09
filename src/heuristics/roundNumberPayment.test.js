/**
 * src/heuristics/roundNumberPayment.test.js
 *
 * Unit tests for roundNumberPayment.js.
 *
 * Run:  node --test src/heuristics/roundNumberPayment.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { roundNumberPayment } from './roundNumberPayment.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NULL_TXID = '0'.repeat(64);
const DUMMY_TXID = 'ab'.repeat(32);
const SPK = (n) => '0014' + n.toString(16).padStart(2, '0').repeat(20);

function makeTx(values) {
    return {
        txid: DUMMY_TXID,
        version: 1,
        vin: [{ prev_txid: DUMMY_TXID, vout: 0, scriptSig: '', sequence: 0xffffffff }],
        vout: values.map((v, i) => ({ value_sats: v, scriptPubKey: SPK(i + 1) })),
        locktime: 0, size: 200, segwit: false,
    };
}

const COINBASE_TX = {
    vin: [{ prev_txid: NULL_TXID, vout: 0xffffffff, scriptSig: '', sequence: 0xffffffff }],
    vout: [{ value_sats: 625_000_000, scriptPubKey: SPK(1) }],
};

// ── Suite: id ─────────────────────────────────────────────────────────────────

describe('roundNumberPayment — id', () => {
    it('has id "round_number_payment"', () => {
        assert.strictEqual(roundNumberPayment.id, 'round_number_payment');
    });
});

// ── Suite: coinbase skip ───────────────────────────────────────────────────────

describe('roundNumberPayment — coinbase skip', () => {
    it('returns detected:false for coinbase', () => {
        // 625_000_000 is a multiple of 500_000_000, but it is a coinbase
        const r = roundNumberPayment.analyze(COINBASE_TX);
        assert.strictEqual(r.detected, false);
        assert.deepStrictEqual(r.payment_indices, []);
        assert.strictEqual(r.cadence_sats, 0);
    });
});

// ── Suite: non-detection ───────────────────────────────────────────────────────

describe('roundNumberPayment — non-detection', () => {
    it('not detected when all outputs are non-round', () => {
        const tx = makeTx([123_456, 789_012]);
        assert.strictEqual(roundNumberPayment.analyze(tx).detected, false);
    });

    it('not detected for zero-value outputs', () => {
        const tx = makeTx([0, 0]);
        assert.strictEqual(roundNumberPayment.analyze(tx).detected, false);
    });

    it('not detected for an empty vout', () => {
        const tx = makeTx([]);
        assert.strictEqual(roundNumberPayment.analyze(tx).detected, false);
    });

    it('not detected for values just below the smallest cadence', () => {
        // 999_999 is NOT a multiple of 1_000_000
        const tx = makeTx([999_999, 333_333]);
        assert.strictEqual(roundNumberPayment.analyze(tx).detected, false);
    });
});

// ── Suite: detection — individual cadences ────────────────────────────────────

describe('roundNumberPayment — detection by cadence', () => {
    it('detects 0.01 BTC output (1_000_000 sat cadence)', () => {
        const tx = makeTx([1_000_000, 234_567]);
        const r = roundNumberPayment.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.deepStrictEqual(r.payment_indices, [0]);
        assert.strictEqual(r.cadence_sats, 1_000_000);
    });

    it('detects 0.1 BTC output (10_000_000 sat cadence)', () => {
        const tx = makeTx([10_000_000, 987_654]);
        const r = roundNumberPayment.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.deepStrictEqual(r.payment_indices, [0]);
        assert.strictEqual(r.cadence_sats, 1_000_000); // smallest matching cadence
    });

    it('detects 1 BTC output (100_000_000 sat cadence)', () => {
        const tx = makeTx([100_000_000, 456_789]);
        const r = roundNumberPayment.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.deepStrictEqual(r.payment_indices, [0]);
    });

    it('detects 5 BTC output (500_000_000 sat cadence)', () => {
        const tx = makeTx([500_000_000, 123_456]);
        const r = roundNumberPayment.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.deepStrictEqual(r.payment_indices, [0]);
    });
});

// ── Suite: multiple round outputs ─────────────────────────────────────────────

describe('roundNumberPayment — multiple round outputs', () => {
    it('reports all round output indices', () => {
        // index 0: 1_000_000 (round), index 1: 123_456 (not), index 2: 10_000_000 (round)
        const tx = makeTx([1_000_000, 123_456, 10_000_000]);
        const r = roundNumberPayment.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.deepStrictEqual(r.payment_indices, [0, 2]);
    });

    it('cadence_sats is the smallest matching cadence across all round outputs', () => {
        // Both 1_000_000 and 10_000_000 match; smallest cadence is 1_000_000
        const tx = makeTx([1_000_000, 10_000_000]);
        const r = roundNumberPayment.analyze(tx);
        assert.strictEqual(r.cadence_sats, 1_000_000);
    });
});

// ── Suite: output format ───────────────────────────────────────────────────────

describe('roundNumberPayment — output format', () => {
    it('detected result has all required fields with correct types', () => {
        const tx = makeTx([1_000_000, 234_567]);
        const r = roundNumberPayment.analyze(tx);
        assert.strictEqual(typeof r.detected, 'boolean');
        assert.ok(Array.isArray(r.payment_indices), 'payment_indices should be an array');
        assert.strictEqual(typeof r.cadence_sats, 'number');
    });

    it('not-detected result has cadence_sats = 0 and empty payment_indices', () => {
        const tx = makeTx([]);
        const r = roundNumberPayment.analyze(tx);
        assert.strictEqual(r.detected, false);
        assert.deepStrictEqual(r.payment_indices, []);
        assert.strictEqual(r.cadence_sats, 0);
    });
});
