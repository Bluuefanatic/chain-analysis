/**
 * src/analysis/feeCalculator.test.js
 *
 * Unit tests for feeCalculator.js using the Node.js built-in test runner.
 *
 * Run single file:  node --test src/analysis/feeCalculator.test.js
 * Run all tests:    node --test
 *
 * All test data is built programmatically from plain objects — no fixture
 * files are required.
 *
 * SegWit witness byte accounting (used throughout)
 * ─────────────────────────────────────────────────
 * This test suite uses a canonical P2WPKH-style witness stack:
 *   item 0: 71-byte DER signature
 *   item 1: 33-byte compressed public key
 *
 * On the wire that costs:
 *   2   bytes — marker (0x00) + flag (0x01)
 *   1   byte  — varint(2 stack items)
 *   1   byte  — varint(71) for sig length
 *  71   bytes — sig data
 *   1   byte  — varint(33) for pubkey length
 *  33   bytes — pubkey data
 * ──────────────────────────────────
 * 109  bytes total  (SEGWIT_WITNESS_BYTES constant below)
 *
 * Given a total serialized size of SEG_TOTAL_SIZE (192 bytes):
 *   base_size = 192 − 109 = 83
 *   weight    = 83 × 4 + 109 = 441
 *   vsize     = ceil(441 / 4) = 111
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeFeeStats } from './feeCalculator.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const NULL_TXID = '0'.repeat(64);
const DUMMY_TXID = 'ab'.repeat(32);
const DUMMY_SCRIPT = '76a914' + 'aa'.repeat(20) + '88ac';
const SEGWIT_WITNESS_BYTES = 109; // see file header
const SEG_TOTAL_SIZE = 192;    // representative P2WPKH transaction wire size

// ── Fixture builders ──────────────────────────────────────────────────────────

/**
 * Build a { tx, prevouts } entry for a legacy (non-SegWit) transaction.
 *
 * @param {object} opts
 * @param {number[]} opts.inputValues   Prevout values in satoshis.
 * @param {number[]} opts.outputValues  Output values in satoshis.
 * @param {number}   opts.size          Total serialized size in bytes.
 * @returns {{ tx: object, prevouts: object[] }}
 */
function makeLegacyEntry({ inputValues, outputValues, size }) {
    const tx = {
        txid: DUMMY_TXID,
        version: 1,
        vin: inputValues.map((_, i) => ({
            prev_txid: DUMMY_TXID,
            vout: i,
            scriptSig: 'deadbeef',
            sequence: 0xffffffff,
        })),
        vout: outputValues.map(value_sats => ({ value_sats, scriptPubKey: DUMMY_SCRIPT })),
        locktime: 0,
        size,
        segwit: false,
    };
    const prevouts = inputValues.map(value_sats => ({ value_sats, script_pubkey: '' }));
    return { tx, prevouts };
}

/**
 * Build a { tx, prevouts } entry for a SegWit transaction with a single
 * P2WPKH-style input (witness: [71-byte sig, 33-byte pubkey]).
 *
 * @param {object} opts
 * @param {number} opts.inputValue   Prevout value in satoshis.
 * @param {number} opts.outputValue  Output value in satoshis.
 * @param {number} opts.size         Total serialized size (including witness).
 * @returns {{ tx: object, prevouts: object[] }}
 */
function makeSegwitEntry({ inputValue, outputValue, size }) {
    const sig71 = '31'.repeat(71); // 71 dummy bytes as hex (142 hex chars)
    const pub33 = 'ab'.repeat(33); // 33 dummy bytes as hex (66 hex chars)

    const tx = {
        txid: DUMMY_TXID,
        version: 1,
        vin: [{
            prev_txid: DUMMY_TXID,
            vout: 0,
            scriptSig: '',
            sequence: 0xffffffff,
            witness: [sig71, pub33],
        }],
        vout: [{ value_sats: outputValue, scriptPubKey: '0014' + 'aa'.repeat(20) }],
        locktime: 0,
        size,
        segwit: true,
    };
    const prevouts = [{ value_sats: inputValue, script_pubkey: '' }];
    return { tx, prevouts };
}

/** A well-formed coinbase entry (should be ignored by computeFeeStats). */
const COINBASE_ENTRY = {
    tx: {
        txid: 'cc'.repeat(32),
        version: 1,
        vin: [{
            prev_txid: NULL_TXID,
            vout: 0xffffffff,
            scriptSig: 'aabbcc',
            sequence: 0xffffffff,
        }],
        vout: [{ value_sats: 625_000_000, scriptPubKey: DUMMY_SCRIPT }],
        locktime: 0,
        size: 130,
        segwit: false,
    },
    prevouts: [], // coinbase has no prevouts
};

// ── Suite 1: Coinbase handling ────────────────────────────────────────────────

describe('computeFeeStats — coinbase handling', () => {
    it('throws when the only entry is a coinbase transaction', () => {
        assert.throws(
            () => computeFeeStats([COINBASE_ENTRY]),
            /no non-coinbase/i
        );
    });

    it('throws when an empty array is provided', () => {
        assert.throws(
            () => computeFeeStats([]),
            /no non-coinbase/i
        );
    });

    it('ignores a coinbase mixed in with regular transactions', () => {
        // fee = 1_000, vsize = 100, fee_rate = 10
        const regular = makeLegacyEntry({ inputValues: [11_000], outputValues: [10_000], size: 100 });
        const stats = computeFeeStats([COINBASE_ENTRY, regular]);

        assert.strictEqual(stats.min_sat_vb, 10);
        assert.strictEqual(stats.max_sat_vb, 10);
        assert.strictEqual(stats.median_sat_vb, 10);
        assert.strictEqual(stats.mean_sat_vb, 10);
    });
});

// ── Suite 2: Single legacy transaction ───────────────────────────────────────

describe('computeFeeStats — single legacy transaction', () => {
    // fee = 10_000 sat, vsize = 200 bytes, fee_rate = 50 sat/vbyte
    const entry = makeLegacyEntry({ inputValues: [110_000], outputValues: [100_000], size: 200 });

    it('min equals the single fee rate', () => {
        assert.strictEqual(computeFeeStats([entry]).min_sat_vb, 50);
    });

    it('max equals the single fee rate', () => {
        assert.strictEqual(computeFeeStats([entry]).max_sat_vb, 50);
    });

    it('median equals the single fee rate', () => {
        assert.strictEqual(computeFeeStats([entry]).median_sat_vb, 50);
    });

    it('mean equals the single fee rate', () => {
        assert.strictEqual(computeFeeStats([entry]).mean_sat_vb, 50);
    });
});

// ── Suite 3: Multiple legacy transactions — statistics ────────────────────────

describe('computeFeeStats — statistics over three transactions (odd count)', () => {
    // fee_rates: 50, 20, 1 → sorted: [1, 20, 50]
    const entries = [
        makeLegacyEntry({ inputValues: [110_000], outputValues: [100_000], size: 200 }), // 10_000/200 = 50
        makeLegacyEntry({ inputValues: [505_000], outputValues: [500_000], size: 250 }), //  5_000/250 = 20
        makeLegacyEntry({ inputValues: [300_300], outputValues: [300_000], size: 300 }), //    300/300 =  1
    ];

    it('min is the lowest fee rate', () => {
        assert.strictEqual(computeFeeStats(entries).min_sat_vb, 1);
    });

    it('max is the highest fee rate', () => {
        assert.strictEqual(computeFeeStats(entries).max_sat_vb, 50);
    });

    it('median is the middle value for an odd-length sorted array', () => {
        assert.strictEqual(computeFeeStats(entries).median_sat_vb, 20);
    });

    it('mean is the arithmetic mean of all fee rates', () => {
        // (1 + 20 + 50) / 3 = 71/3
        const expected = 71 / 3;
        assert.ok(Math.abs(computeFeeStats(entries).mean_sat_vb - expected) < 1e-10);
    });
});

// ── Suite 4: Even number of transactions — median interpolation ───────────────

describe('computeFeeStats — median of an even-count set', () => {
    // fee_rates: 10, 20, 30, 40 → median = (20 + 30) / 2 = 25
    const entries = [
        makeLegacyEntry({ inputValues: [11_000], outputValues: [10_000], size: 100 }), // 1_000/100 = 10
        makeLegacyEntry({ inputValues: [13_000], outputValues: [10_000], size: 100 }), // 3_000/100 = 30
        makeLegacyEntry({ inputValues: [12_000], outputValues: [10_000], size: 100 }), // 2_000/100 = 20
        makeLegacyEntry({ inputValues: [14_000], outputValues: [10_000], size: 100 }), // 4_000/100 = 40
    ];

    it('median is the average of the two middle values', () => {
        assert.strictEqual(computeFeeStats(entries).median_sat_vb, 25);
    });

    it('min is correct', () => {
        assert.strictEqual(computeFeeStats(entries).min_sat_vb, 10);
    });

    it('max is correct', () => {
        assert.strictEqual(computeFeeStats(entries).max_sat_vb, 40);
    });

    it('mean is correct', () => {
        assert.strictEqual(computeFeeStats(entries).mean_sat_vb, 25);
    });
});

// ── Suite 5: SegWit virtual-size discount ─────────────────────────────────────

describe('computeFeeStats — SegWit virtual size (P2WPKH)', () => {
    // Witness for one input: [71-byte sig, 33-byte pubkey]
    //   witness_bytes = 2 + 1 + (1+71) + (1+33) = 109
    //   base_size     = SEG_TOTAL_SIZE − 109 = 192 − 109 = 83
    //   weight        = 83 × 4 + 109            = 441
    //   vsize         = ceil(441 / 4)            = 111
    //
    // fee = 1_110 sat  →  fee_rate = 1_110 / 111 = 10 sat/vbyte
    const entry = makeSegwitEntry({
        inputValue: 1_109_000 + 1_110, // = 1_110_110
        outputValue: 1_109_000,
        size: SEG_TOTAL_SIZE,
    });

    // Expected vsize is 111, not 192 (full wire size)
    it('fee rate uses virtual size, not raw byte count', () => {
        const stats = computeFeeStats([entry]);
        assert.strictEqual(stats.min_sat_vb, 10);
    });

    it('segwit fee rate differs from what legacy calculation would give', () => {
        const stats = computeFeeStats([entry]);
        // If vsize were naively set to 192 the rate would NOT be 10
        assert.notStrictEqual(stats.min_sat_vb, 1_110 / SEG_TOTAL_SIZE);
    });
});

// ── Suite 6: Zero-fee transaction ─────────────────────────────────────────────

describe('computeFeeStats — zero-fee transaction', () => {
    it('accepts a zero-fee transaction (fee_rate = 0)', () => {
        // output value equals input value → fee = 0
        const entry = makeLegacyEntry({ inputValues: [50_000], outputValues: [50_000], size: 200 });
        const stats = computeFeeStats([entry]);
        assert.strictEqual(stats.min_sat_vb, 0);
        assert.strictEqual(stats.max_sat_vb, 0);
        assert.strictEqual(stats.median_sat_vb, 0);
        assert.strictEqual(stats.mean_sat_vb, 0);
    });
});

// ── Suite 7: Negative fee guard ───────────────────────────────────────────────

describe('computeFeeStats — negative fee guard', () => {
    it('throws when output value exceeds input value (mismatched prevouts)', () => {
        // output 60_000 > input 50_000 → fee = −10_000
        const entry = makeLegacyEntry({ inputValues: [50_000], outputValues: [60_000], size: 200 });
        assert.throws(
            () => computeFeeStats([entry]),
            /negative fee/i
        );
    });
});
