/**
 * src/heuristics/coinjoin.test.js
 *
 * Unit tests for coinjoin.js.
 *
 * Run:  node --test src/heuristics/coinjoin.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { coinjoin } from './coinjoin.js';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const NULL_TXID  = '0'.repeat(64);
const DUMMY_TXID = 'ab'.repeat(32);
const SPK        = (n) => '0014' + n.toString(16).padStart(2, '0').repeat(20);

function makeVin(count) {
    return Array.from({ length: count }, (_, i) => ({
        prev_txid: DUMMY_TXID, vout: i, scriptSig: '', sequence: 0xffffffff,
    }));
}

function makeVout(values) {
    return values.map((v, i) => ({ value_sats: v, scriptPubKey: SPK(i + 1) }));
}

const COINBASE_TX = {
    vin:  [{ prev_txid: NULL_TXID, vout: 0xffffffff, scriptSig: '', sequence: 0xffffffff }],
    vout: makeVout([625_000_000]),
};

// ── Suite: id ─────────────────────────────────────────────────────────────────

describe('coinjoin — id', () => {
    it('has id "coinjoin"', () => {
        assert.strictEqual(coinjoin.id, 'coinjoin');
    });
});

// ── Suite: coinbase skip ───────────────────────────────────────────────────────

describe('coinjoin — coinbase skip', () => {
    it('returns detected:false for coinbase', () => {
        const r = coinjoin.analyze(COINBASE_TX);
        assert.strictEqual(r.detected, false);
        assert.strictEqual(r.equal_output_count, 0);
        assert.strictEqual(r.denomination_sats,  0);
    });
});

// ── Suite: non-detection ───────────────────────────────────────────────────────

describe('coinjoin — non-detection', () => {
    it('not detected for a single-input tx', () => {
        const tx = { vin: makeVin(1), vout: makeVout([100_000, 100_000]) };
        assert.strictEqual(coinjoin.analyze(tx).detected, false);
    });

    it('not detected when all outputs have distinct values', () => {
        const tx = { vin: makeVin(3), vout: makeVout([100_000, 200_000, 300_000]) };
        assert.strictEqual(coinjoin.analyze(tx).detected, false);
    });

    it('not detected when equal outputs are below min denomination (dust)', () => {
        // 2 outputs of 9_999 sat — below the 10 000 sat threshold
        const tx = { vin: makeVin(2), vout: makeVout([9_999, 9_999]) };
        assert.strictEqual(coinjoin.analyze(tx).detected, false);
    });

    it('not detected when only one output has the equal value', () => {
        const tx = { vin: makeVin(2), vout: makeVout([100_000, 200_000]) };
        assert.strictEqual(coinjoin.analyze(tx).detected, false);
    });
});

// ── Suite: detection ──────────────────────────────────────────────────────────

describe('coinjoin — detection', () => {
    it('detects 2 equal outputs meeting the min denomination', () => {
        // Classic 2-party join: 2 equal denomination outputs
        const tx = { vin: makeVin(2), vout: makeVout([100_000, 100_000]) };
        const r = coinjoin.analyze(tx);
        assert.strictEqual(r.detected,           true);
        assert.strictEqual(r.equal_output_count, 2);
        assert.strictEqual(r.denomination_sats,  100_000);
    });

    it('detects a 5-output Wasabi-style join', () => {
        const DENOM = 1_000_000;
        const tx = {
            vin:  makeVin(5),
            vout: makeVout([DENOM, DENOM, DENOM, DENOM, DENOM]),
        };
        const r = coinjoin.analyze(tx);
        assert.strictEqual(r.detected,           true);
        assert.strictEqual(r.equal_output_count, 5);
        assert.strictEqual(r.denomination_sats,  DENOM);
    });

    it('picks the denomination with the highest equal-output count', () => {
        // 3 outputs of 100_000, 2 outputs of 200_000, 1 change output
        const tx = {
            vin:  makeVin(4),
            vout: makeVout([100_000, 100_000, 100_000, 200_000, 200_000, 987_654]),
        };
        const r = coinjoin.analyze(tx);
        assert.strictEqual(r.detected,           true);
        assert.strictEqual(r.denomination_sats,  100_000);
        assert.strictEqual(r.equal_output_count, 3);
    });

    it('detects even when mixed with non-equal change outputs', () => {
        const tx = {
            vin:  makeVin(3),
            vout: makeVout([500_000, 500_000, 123_456]),
        };
        const r = coinjoin.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.denomination_sats, 500_000);
    });

    it('equal outputs at exactly min denomination (10 000 sat) are detected', () => {
        const tx = { vin: makeVin(2), vout: makeVout([10_000, 10_000]) };
        const r = coinjoin.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.denomination_sats, 10_000);
    });
});
