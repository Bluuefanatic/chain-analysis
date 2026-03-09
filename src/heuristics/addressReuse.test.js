/**
 * src/heuristics/addressReuse.test.js
 *
 * Unit tests for addressReuse.js.
 *
 * Run:  node --test src/heuristics/addressReuse.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { addressReuse } from './addressReuse.js';

// ── Script fixtures ────────────────────────────────────────────────────────────

const NULL_TXID  = '0'.repeat(64);
const DUMMY_TXID = 'ab'.repeat(32);

const SPK_A = '0014' + 'aa'.repeat(20); // P2WPKH address A
const SPK_B = '0014' + 'bb'.repeat(20); // P2WPKH address B
const SPK_C = '0014' + 'cc'.repeat(20); // P2WPKH address C

function makeTx(vout, extraVin = []) {
    const vin = [
        { prev_txid: DUMMY_TXID, vout: 0, scriptSig: '', sequence: 0xffffffff },
        ...extraVin,
    ];
    return { txid: DUMMY_TXID, version: 1, vin, vout, locktime: 0, size: 200, segwit: false };
}

const COINBASE_TX = {
    vin: [{ prev_txid: NULL_TXID, vout: 0xffffffff, scriptSig: '', sequence: 0xffffffff }],
    vout: [{ value_sats: 625_000_000, scriptPubKey: SPK_A }],
};

// ── Suite: id ─────────────────────────────────────────────────────────────────

describe('addressReuse — id', () => {
    it('has id "address_reuse"', () => {
        assert.strictEqual(addressReuse.id, 'address_reuse');
    });
});

// ── Suite: coinbase skip ───────────────────────────────────────────────────────

describe('addressReuse — coinbase skip', () => {
    it('returns detected:false for coinbase', () => {
        const r = addressReuse.analyze(COINBASE_TX, { prevouts: [{ script_pubkey: SPK_A }] });
        assert.strictEqual(r.detected, false);
        assert.deepStrictEqual(r.reused_indices, []);
    });
});

// ── Suite: no prevouts ─────────────────────────────────────────────────────────

describe('addressReuse — no prevouts in context', () => {
    it('returns detected:false when context has no prevouts', () => {
        const tx = makeTx([{ value_sats: 500_000, scriptPubKey: SPK_A }]);
        assert.strictEqual(addressReuse.analyze(tx).detected, false);
    });

    it('returns detected:false when prevouts is an empty array', () => {
        const tx = makeTx([{ value_sats: 500_000, scriptPubKey: SPK_A }]);
        assert.strictEqual(addressReuse.analyze(tx, { prevouts: [] }).detected, false);
    });
});

// ── Suite: reuse detection ─────────────────────────────────────────────────────

describe('addressReuse — detection', () => {
    it('detects reuse when an output script matches a prevout script', () => {
        const tx = makeTx([{ value_sats: 500_000, scriptPubKey: SPK_A }]);
        const context = { prevouts: [{ script_pubkey: SPK_A }] };
        const r = addressReuse.analyze(tx, context);
        assert.strictEqual(r.detected, true);
        assert.deepStrictEqual(r.reused_indices, [0]);
    });

    it('reports all output indices where reuse occurs', () => {
        const tx = makeTx([
            { value_sats: 200_000, scriptPubKey: SPK_A },
            { value_sats: 300_000, scriptPubKey: SPK_B },
            { value_sats: 400_000, scriptPubKey: SPK_A }, // reuse again
        ]);
        const context = { prevouts: [{ script_pubkey: SPK_A }] };
        const r = addressReuse.analyze(tx, context);
        assert.strictEqual(r.detected, true);
        assert.deepStrictEqual(r.reused_indices, [0, 2]);
    });

    it('does not flag an output that uses a different script', () => {
        const tx = makeTx([
            { value_sats: 200_000, scriptPubKey: SPK_B },
            { value_sats: 300_000, scriptPubKey: SPK_C },
        ]);
        const context = { prevouts: [{ script_pubkey: SPK_A }] };
        const r = addressReuse.analyze(tx, context);
        assert.strictEqual(r.detected, false);
        assert.deepStrictEqual(r.reused_indices, []);
    });

    it('matches across multiple prevouts', () => {
        // Two inputs from SPK_A and SPK_B; output reuses SPK_B
        const tx = makeTx(
            [{ value_sats: 500_000, scriptPubKey: SPK_B }],
            [{ prev_txid: DUMMY_TXID, vout: 1, scriptSig: '', sequence: 0xffffffff }]
        );
        const context = { prevouts: [{ script_pubkey: SPK_A }, { script_pubkey: SPK_B }] };
        const r = addressReuse.analyze(tx, context);
        assert.strictEqual(r.detected, true);
        assert.deepStrictEqual(r.reused_indices, [0]);
    });

    it('comparison is case-insensitive', () => {
        const tx = makeTx([{ value_sats: 500_000, scriptPubKey: SPK_A.toUpperCase() }]);
        const context = { prevouts: [{ script_pubkey: SPK_A.toLowerCase() }] };
        const r = addressReuse.analyze(tx, context);
        assert.strictEqual(r.detected, true);
    });
});
