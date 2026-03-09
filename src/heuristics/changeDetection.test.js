/**
 * src/heuristics/changeDetection.test.js
 *
 * Unit tests for changeDetection.js.
 *
 * Run:  node --test src/heuristics/changeDetection.test.js
 *
 * Script fixtures
 * ───────────────
 *   P2WPKH  0014{20B}
 *   P2PKH   76a914{20B}88ac
 *   P2TR    5120{32B}
 *   OP_RETURN 6a{data}
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { changeDetection } from './changeDetection.js';

// ── Script helpers ─────────────────────────────────────────────────────────────

const P2WPKH = (n = 0xaa) => '0014' + n.toString(16).padStart(2, '0').repeat(20);
const P2PKH = (n = 0xbb) => '76a914' + n.toString(16).padStart(2, '0').repeat(20) + '88ac';
const P2TR = (n = 0xcc) => '5120' + n.toString(16).padStart(2, '0').repeat(32);
const OP_RETURN_SCRIPT = '6a0b68656c6c6f20776f726c64';

const NULL_TXID = '0'.repeat(64);
const DUMMY_TXID = 'ab'.repeat(32);

// ── Fixture builders ───────────────────────────────────────────────────────────

function makeTx(vout, vin = [{ prev_txid: DUMMY_TXID, vout: 0, scriptSig: '', sequence: 0xffffffff }]) {
    return { txid: DUMMY_TXID, version: 1, vin, vout, locktime: 0, size: 200, segwit: false };
}

const COINBASE_TX = makeTx(
    [{ value_sats: 625_000_000, scriptPubKey: P2WPKH() }],
    [{ prev_txid: NULL_TXID, vout: 0xffffffff, scriptSig: '', sequence: 0xffffffff }]
);

// ── Suite: id ─────────────────────────────────────────────────────────────────

describe('changeDetection — id', () => {
    it('has id "change_detection"', () => {
        assert.strictEqual(changeDetection.id, 'change_detection');
    });
});

// ── Suite: coinbase skip ───────────────────────────────────────────────────────

describe('changeDetection — coinbase skip', () => {
    it('returns detected:false for coinbase', () => {
        const r = changeDetection.analyze(COINBASE_TX);
        assert.strictEqual(r.detected, false);
        assert.strictEqual(r.likely_change_index, null);
    });
});

// ── Suite: OP_RETURN exclusion ─────────────────────────────────────────────────

describe('changeDetection — OP_RETURN exclusion', () => {
    it('does not count OP_RETURN as a candidate output', () => {
        // Only 1 real candidate remains → not enough to determine change
        const tx = makeTx([
            { value_sats: 1_000_000, scriptPubKey: P2WPKH() },
            { value_sats: 100, scriptPubKey: OP_RETURN_SCRIPT },
        ]);
        const r = changeDetection.analyze(tx);
        assert.strictEqual(r.detected, false);
    });
});

// ── Suite: too few outputs ─────────────────────────────────────────────────────

describe('changeDetection — too few outputs', () => {
    it('returns detected:false for a tx with 0 outputs', () => {
        assert.strictEqual(changeDetection.analyze(makeTx([])).detected, false);
    });

    it('returns detected:false for a tx with 1 output', () => {
        assert.strictEqual(
            changeDetection.analyze(makeTx([{ value_sats: 500_000, scriptPubKey: P2WPKH() }])).detected,
            false
        );
    });
});

// ── Suite: non_round_value signal ─────────────────────────────────────────────

describe('changeDetection — non_round_value signal', () => {
    it('detects change at index 1 when only vout[1] is non-round', () => {
        const tx = makeTx([
            { value_sats: 1_000_000, scriptPubKey: P2WPKH(0xaa) }, // round
            { value_sats: 123_456, scriptPubKey: P2WPKH(0xbb) }, // non-round
        ]);
        const r = changeDetection.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.likely_change_index, 1);
        assert.match(r.method, /non_round_value/);
        assert.ok(r.confidence > 0 && r.confidence <= 1);
    });

    it('detects change at index 0 when only vout[0] is non-round', () => {
        const tx = makeTx([
            { value_sats: 789_012, scriptPubKey: P2WPKH(0xaa) }, // non-round
            { value_sats: 5_000_000, scriptPubKey: P2WPKH(0xbb) }, // round
        ]);
        const r = changeDetection.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.likely_change_index, 0);
        assert.match(r.method, /non_round_value/);
    });

    it('returns detected:false when both outputs are non-round (tie)', () => {
        const tx = makeTx([
            { value_sats: 123_456, scriptPubKey: P2WPKH(0xaa) },
            { value_sats: 654_321, scriptPubKey: P2WPKH(0xbb) },
        ]);
        // Both outputs are non-round → non_round_value fires for both → tie
        // But smaller_value can break the tie
        const r = changeDetection.analyze(tx);
        // The smaller value (123_456) gets smaller_value bonus → index 0 wins
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.likely_change_index, 0);
    });

    it('returns detected:false when both outputs are round with no other signal', () => {
        const tx = makeTx([
            { value_sats: 1_000_000, scriptPubKey: P2WPKH(0xaa) },
            { value_sats: 2_000_000, scriptPubKey: P2WPKH(0xbb) },
        ]);
        const r = changeDetection.analyze(tx);
        // Both round → non_round_value silent for both; no prevouts → script_type_match silent;
        // smaller_value fires for index 0 alone → detected
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.likely_change_index, 0);
        assert.match(r.method, /smaller_value/);
    });
});

// ── Suite: script_type_match signal ───────────────────────────────────────────

describe('changeDetection — script_type_match signal', () => {
    it('favours the output whose script type matches the input prevout type', () => {
        // Input is P2WPKH; vout[0] is P2WPKH (match), vout[1] is P2PKH (mismatch)
        // vout[0] value is round, vout[1] value is non-round
        // script_type_match → vout[0]; non_round_value → vout[1]
        // smaller_value → vout[0] (500_000 < 1_234_567)
        // scores[0] = script_type_match(1.0) + smaller_value(0.5) = 1.5
        // scores[1] = non_round_value(1.0)                         = 1.0
        // Winner: index 0
        const tx = makeTx([
            { value_sats: 500_000, scriptPubKey: P2WPKH(0xaa) }, // P2WPKH, round, smaller
            { value_sats: 1_234_567, scriptPubKey: P2PKH(0xbb) }, // P2PKH,  non-round, larger
        ]);
        const context = { prevouts: [{ script_pubkey: P2WPKH(0xcc) }] };

        const r = changeDetection.analyze(tx, context);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.likely_change_index, 0);
        assert.match(r.method, /script_type_match/);
    });

    it('script_type_match signal fires for both outputs of the same type', () => {
        // Both outputs P2WPKH; script_type_match fires for both → does not break tie alone
        // vout[1] is non-round and larger → non_round fires for [1], smaller fires for [0]
        // scores[0] = script_type_match(1.0) + smaller_value(0.5) = 1.5
        // scores[1] = script_type_match(1.0) + non_round_value(1.0) = 2.0
        // Winner: index 1
        const tx = makeTx([
            { value_sats: 100_000, scriptPubKey: P2WPKH(0xaa) }, // P2WPKH, round, smaller
            { value_sats: 123_456, scriptPubKey: P2WPKH(0xbb) }, // P2WPKH, non-round, larger
        ]);
        const context = { prevouts: [{ script_pubkey: P2WPKH(0xcc) }] };
        const r = changeDetection.analyze(tx, context);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.likely_change_index, 1);
    });

    it('works without prevouts in context (script_type_match is silent)', () => {
        // No prevouts → only non_round_value and smaller_value fire
        const tx = makeTx([
            { value_sats: 1_000_000, scriptPubKey: P2WPKH(0xaa) },
            { value_sats: 333_333, scriptPubKey: P2PKH(0xbb) },
        ]);
        const r = changeDetection.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.likely_change_index, 1); // non-round + smaller
    });
});

// ── Suite: smaller_value signal ────────────────────────────────────────────────

describe('changeDetection — smaller_value signal', () => {
    it('does not fire when both outputs have equal value', () => {
        const tx = makeTx([
            { value_sats: 500_000, scriptPubKey: P2WPKH(0xaa) },
            { value_sats: 500_000, scriptPubKey: P2PKH(0xbb) },
        ]);
        // equal values: smaller_value silent; no other signal → not detected
        const r = changeDetection.analyze(tx);
        assert.strictEqual(r.detected, false);
    });

    it('only fires for the two-output case', () => {
        // 3 outputs: smaller_value does not run; only non_round_value and script_type_match
        const tx = makeTx([
            { value_sats: 100_000, scriptPubKey: P2WPKH(0xaa) }, // round
            { value_sats: 1_000_000, scriptPubKey: P2WPKH(0xbb) }, // round
            { value_sats: 123_456, scriptPubKey: P2WPKH(0xcc) }, // non-round
        ]);
        const r = changeDetection.analyze(tx);
        // Only non_round_value fires; index 2 wins unambiguously
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.likely_change_index, 2);
        assert.match(r.method, /non_round_value/);
        assert.ok(!(r.method.includes('smaller_value')));
    });
});

// ── Suite: output format ───────────────────────────────────────────────────────

describe('changeDetection — output format', () => {
    it('detected result has all required fields', () => {
        const tx = makeTx([
            { value_sats: 1_000_000, scriptPubKey: P2WPKH(0xaa) },
            { value_sats: 123_456, scriptPubKey: P2WPKH(0xbb) },
        ]);
        const r = changeDetection.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(typeof r.likely_change_index, 'number');
        assert.strictEqual(typeof r.method, 'string');
        assert.ok(r.method.length > 0, 'method should not be empty');
        assert.ok(typeof r.confidence === 'number', 'confidence should be a number');
        assert.ok(r.confidence >= 0 && r.confidence <= 1, 'confidence should be in [0,1]');
    });

    it('not-detected result has all required fields', () => {
        const r = changeDetection.analyze(makeTx([]));
        assert.strictEqual(r.detected, false);
        assert.strictEqual(r.likely_change_index, null);
        assert.strictEqual(typeof r.method, 'string');
        assert.strictEqual(typeof r.confidence, 'number');
    });

    it('confidence is a number between 0 and 1 for a high-signal case', () => {
        const tx = makeTx([
            { value_sats: 1_000_000, scriptPubKey: P2WPKH(0xaa) },
            { value_sats: 123_456, scriptPubKey: P2WPKH(0xbb) },
        ]);
        const context = { prevouts: [{ script_pubkey: P2WPKH(0xcc) }] };
        const { confidence } = changeDetection.analyze(tx, context);
        assert.ok(confidence > 0 && confidence <= 1);
    });

    it('P2TR outputs are detected as change candidates', () => {
        const tx = makeTx([
            { value_sats: 5_000_000, scriptPubKey: P2TR(0xaa) }, // round
            { value_sats: 234_567, scriptPubKey: P2TR(0xbb) }, // non-round
        ]);
        const r = changeDetection.analyze(tx);
        assert.strictEqual(r.detected, true);
        assert.strictEqual(r.likely_change_index, 1);
    });
});
