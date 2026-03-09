/**
 * src/analysis/classifier.test.js
 *
 * Unit tests for classifier.js.
 *
 * Run:  node --test src/analysis/classifier.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyTransaction } from './classifier.js';

// ── Script helpers ─────────────────────────────────────────────────────────────

const NULL_TXID = '0'.repeat(64);
const DUMMY_TXID = 'ab'.repeat(32);

const SPK = (n) => '0014' + n.toString(16).padStart(2, '0').repeat(20); // P2WPKH
const OP_RETURN_SPK = '6a0b68656c6c6f20776f726c64';

function makeVin(count, opts = {}) {
    return Array.from({ length: count }, (_, i) => ({
        prev_txid: opts.nullHash ? NULL_TXID : DUMMY_TXID,
        vout: opts.nullHash ? 0xffffffff : i,
        scriptSig: '',
        sequence: 0xffffffff,
    }));
}

function makeVout(values, scriptFn = (i) => SPK(i + 1)) {
    return values.map((v, i) => ({ value_sats: v, scriptPubKey: scriptFn(i) }));
}

function makeTx(inputCount, outputValues, opts = {}) {
    return {
        txid: DUMMY_TXID,
        version: 1,
        vin: opts.vin ?? makeVin(inputCount),
        vout: makeVout(outputValues, opts.scriptFn),
        locktime: 0,
        size: 200,
        segwit: false,
    };
}

const COINBASE_TX = {
    vin: makeVin(1, { nullHash: true }),
    vout: makeVout([625_000_000]),
};

// ── Suite: result shape ────────────────────────────────────────────────────────

describe('classifyTransaction — result shape', () => {
    it('always returns classification and heuristics keys', () => {
        const r = classifyTransaction(makeTx(1, [500_000, 123_456]));
        assert.ok('classification' in r, 'missing classification');
        assert.ok('heuristics' in r, 'missing heuristics');
    });

    it('heuristics object contains coinjoin, consolidation, address_reuse keys', () => {
        const r = classifyTransaction(makeTx(1, [500_000, 123_456]));
        assert.ok('coinjoin' in r.heuristics);
        assert.ok('consolidation' in r.heuristics);
        assert.ok('address_reuse' in r.heuristics);
    });
});

// ── Suite: coinbase → unknown ─────────────────────────────────────────────────

describe('classifyTransaction — coinbase', () => {
    it('classifies coinbase as unknown', () => {
        assert.strictEqual(classifyTransaction(COINBASE_TX).classification, 'unknown');
    });

    it('heuristics object is empty for coinbase', () => {
        assert.deepStrictEqual(classifyTransaction(COINBASE_TX).heuristics, {});
    });
});

// ── Suite: coinjoin ────────────────────────────────────────────────────────────

describe('classifyTransaction — coinjoin', () => {
    it('classifies as coinjoin when ≥2 inputs and ≥2 equal-value outputs ≥10k sat', () => {
        // 3-in, 3 equal outputs of 100_000 sat → coinjoin
        const tx = makeTx(3, [100_000, 100_000, 100_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'coinjoin');
    });

    it('coinjoin takes priority over consolidation', () => {
        // 6-in, 6 equal outputs → ratio=1, not consolidation; but equal outputs → coinjoin
        const tx = makeTx(6, [500_000, 500_000, 500_000, 500_000, 500_000, 500_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'coinjoin');
    });

    it('coinjoin takes priority over batch_payment (≥3 outputs)', () => {
        const tx = makeTx(2, [200_000, 200_000, 200_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'coinjoin');
    });
});

// ── Suite: consolidation ───────────────────────────────────────────────────────

describe('classifyTransaction — consolidation', () => {
    it('classifies as consolidation for 3-in / 1-out', () => {
        const tx = makeTx(3, [900_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'consolidation');
    });

    it('classifies as consolidation for 9-in / 3-out (ratio 3.0)', () => {
        // Use distinct values so coinjoin does not fire
        const tx = makeTx(9, [100_000, 200_000, 300_000]);
        // ratio = 9/3 = 3.0; consolidation fires before batch_payment
        assert.strictEqual(classifyTransaction(tx).classification, 'consolidation');
    });

    it('classifies as consolidation for 10-in / 2-out (ratio 5.0)', () => {
        const tx = makeTx(10, [500_000, 400_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'consolidation');
    });
});

// ── Suite: batch_payment ───────────────────────────────────────────────────────

describe('classifyTransaction — batch_payment', () => {
    it('classifies as batch_payment for 1-in / 3-out with distinct output values', () => {
        const tx = makeTx(1, [100_000, 200_000, 300_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'batch_payment');
    });

    it('classifies as batch_payment for 2-in / 4-out', () => {
        const tx = makeTx(2, [50_000, 60_000, 70_000, 80_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'batch_payment');
    });

    it('3 outputs but coinjoin overrides batch_payment', () => {
        const tx = makeTx(2, [100_000, 100_000, 100_000]);
        // Equal outputs → coinjoin, not batch_payment
        assert.strictEqual(classifyTransaction(tx).classification, 'coinjoin');
    });
});

// ── Suite: self_transfer ───────────────────────────────────────────────────────

describe('classifyTransaction — self_transfer', () => {
    it('classifies as self_transfer when all outputs reuse input scripts', () => {
        const A = SPK(0xaa);
        const B = SPK(0xbb);
        // Outputs go back to the same two addresses as the inputs
        const tx = {
            txid: DUMMY_TXID, version: 1,
            vin: [
                { prev_txid: DUMMY_TXID, vout: 0, scriptSig: '', sequence: 0xffffffff },
                { prev_txid: DUMMY_TXID, vout: 1, scriptSig: '', sequence: 0xffffffff },
            ],
            vout: [
                { value_sats: 400_000, scriptPubKey: A },
                { value_sats: 500_000, scriptPubKey: B },
            ],
            locktime: 0, size: 200, segwit: false,
        };
        const context = { prevouts: [{ script_pubkey: A }, { script_pubkey: B }] };
        assert.strictEqual(classifyTransaction(tx, context).classification, 'self_transfer');
    });

    it('not a self_transfer when one output goes to a new address', () => {
        const A = SPK(0xaa);
        const B = SPK(0xbb); // new address, not in prevouts
        const tx = makeTx(1, [400_000, 500_000], {
            scriptFn: (i) => [A, B][i],
        });
        const context = { prevouts: [{ script_pubkey: A }] };
        // B is a new address → not all outputs in input set → simple_payment
        assert.strictEqual(classifyTransaction(tx, context).classification, 'simple_payment');
    });

    it('self_transfer with no prevouts context falls through to simple_payment', () => {
        const A = SPK(0xaa);
        const tx = makeTx(1, [400_000, 500_000], { scriptFn: () => A });
        // No context.prevouts → inputScripts empty → cannot confirm self_transfer
        assert.strictEqual(classifyTransaction(tx).classification, 'simple_payment');
    });

    it('self_transfer ignores OP_RETURN outputs', () => {
        const A = SPK(0xaa);
        const tx = {
            txid: DUMMY_TXID, version: 1,
            vin: [{ prev_txid: DUMMY_TXID, vout: 0, scriptSig: '', sequence: 0xffffffff }],
            vout: [
                { value_sats: 0, scriptPubKey: OP_RETURN_SPK },
                { value_sats: 999_000, scriptPubKey: A },
            ],
            locktime: 0, size: 150, segwit: false,
        };
        const context = { prevouts: [{ script_pubkey: A }] };
        // OP_RETURN is excluded; only A output considered → self_transfer
        assert.strictEqual(classifyTransaction(tx, context).classification, 'self_transfer');
    });
});

// ── Suite: simple_payment ──────────────────────────────────────────────────────

describe('classifyTransaction — simple_payment', () => {
    it('classifies 1-in / 2-out as simple_payment', () => {
        const tx = makeTx(1, [300_000, 123_456]);
        assert.strictEqual(classifyTransaction(tx).classification, 'simple_payment');
    });

    it('classifies 2-in / 2-out as simple_payment', () => {
        const tx = makeTx(2, [600_000, 200_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'simple_payment');
    });

    it('classifies 1-in / 1-out as simple_payment (sweep)', () => {
        const tx = makeTx(1, [999_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'simple_payment');
    });

    it('classifies 2-in / 1-out as simple_payment (not consolidation — only 2 inputs)', () => {
        // 2 inputs / 1 output: ratio=2, below consolidation threshold of 3.0
        const tx = makeTx(2, [900_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'simple_payment');
    });
});

// ── Suite: unknown ─────────────────────────────────────────────────────────────

describe('classifyTransaction — unknown', () => {
    it('classifies as unknown for 3-in / 2-out that is not consolidation', () => {
        // 3 inputs, 2 outputs, ratio 1.5 — not consolidation, not batch, not coinjoin
        // But 3 inputs and 2 outputs: inputCount > 2 → does not qualify as simple_payment
        const tx = makeTx(3, [400_000, 500_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'unknown');
    });

    it('classifies as unknown when no vin and no vout', () => {
        const tx = { txid: DUMMY_TXID, version: 1, vin: [], vout: [], locktime: 0, size: 10, segwit: false };
        assert.strictEqual(classifyTransaction(tx).classification, 'unknown');
    });
});

// ── Suite: priority order ──────────────────────────────────────────────────────

describe('classifyTransaction — priority order', () => {
    it('coinjoin > consolidation', () => {
        // 6 inputs, 3 equal outputs of 200_000 — would also be batch_payment
        const tx = makeTx(6, [200_000, 200_000, 200_000]);
        // coinjoin fires (2+ inputs, 3 equal outputs); consolidation: 6/3=2.0 < 3.0 threshold
        assert.strictEqual(classifyTransaction(tx).classification, 'coinjoin');
    });

    it('consolidation > batch_payment', () => {
        // 9 inputs, 3 distinct outputs (no coinjoin) → ratio=3, consolidation fires before batch
        const tx = makeTx(9, [100_000, 200_000, 300_000]);
        assert.strictEqual(classifyTransaction(tx).classification, 'consolidation');
    });

    it('batch_payment > self_transfer (3 outputs even if all reuse scripts)', () => {
        const A = SPK(0xaa);
        // 3 outputs, all reuse script A — batch_payment fires before self_transfer check
        const tx = makeTx(1, [100_000, 200_000, 300_000], { scriptFn: () => A });
        const context = { prevouts: [{ script_pubkey: A }] };
        assert.strictEqual(classifyTransaction(tx, context).classification, 'batch_payment');
    });
});
