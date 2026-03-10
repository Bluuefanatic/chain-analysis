/**
 * src/reports/jsonReport.test.js
 *
 * Schema-validation tests for jsonReport.js.
 *
 * Run:  node --test src/reports/jsonReport.test.js
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { buildReport, generateJsonReport } from './jsonReport.js';

// ── Test-data helpers ─────────────────────────────────────────────────────────

const NULL_TXID = '0'.repeat(64);

// P2WPKH scriptPubKey:  OP_0 OP_PUSH20 <20 bytes>
const SPK_P2WPKH = (seed = 0xab) => '0014' + seed.toString(16).padStart(2, '0').repeat(20);
// P2PKH scriptPubKey:   OP_DUP OP_HASH160 OP_DATA20 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
const SPK_P2PKH = (seed = 0xcd) =>
    '76a914' + seed.toString(16).padStart(2, '0').repeat(20) + '88ac';
// OP_RETURN
const SPK_OP_RET = '6a0b68656c6c6f20776f726c64';

/** Six heuristic IDs — satisfies the ≥5 (incl. cioh + change_detection) requirement. */
const ALL_H_IDS = [
    'cioh', 'change_detection', 'coinjoin',
    'consolidation', 'address_reuse', 'round_number_payment',
];

/** Build a heuristics object with all six entries set to not-detected. */
function noopHeuristics(overrides = {}) {
    return {
        cioh: { detected: false, input_count: 1, confidence: 0.9 },
        change_detection: { detected: false, likely_change_index: null, method: null, confidence: 0 },
        coinjoin: { detected: false, equal_output_count: 0, denomination_sats: 0 },
        consolidation: { detected: false, input_count: 1, output_count: 1, ratio: 1 },
        address_reuse: { detected: false, reused_indices: [] },
        round_number_payment: { detected: false, payment_indices: [], cadence_sats: 0 },
        ...overrides,
    };
}

/** Build a minimal decoded transaction (non-coinbase by default). */
function makeTx({ txid = 'aa'.repeat(32), inputs = 1, values = [100_000, 50_000], segwit = false } = {}) {
    return {
        txid,
        vin: Array.from({ length: inputs }, (_, i) => ({
            prev_txid: 'ff'.repeat(32),
            vout: i,
            scriptSig: '',
            sequence: 0xffffffff,
        })),
        vout: values.map((value_sats, i) => ({
            value_sats,
            scriptPubKey: SPK_P2WPKH(i + 1),
        })),
        size: 250,
        segwit,
    };
}

/** Build a coinbase transaction. */
function makeCoinbaseTx(txid = '00'.repeat(32)) {
    return {
        txid,
        vin: [{
            prev_txid: NULL_TXID,
            vout: 0xffffffff,
            scriptSig: '03a0bb0d',
            sequence: 0xffffffff,
        }],
        vout: [{ value_sats: 625_000_000, scriptPubKey: SPK_P2WPKH(0xff) }],
        size: 120,
        segwit: false,
    };
}

/** Build a prevout array matching a non-coinbase tx's input count. */
function makePrevouts(count, valueEach = 200_000) {
    return Array.from({ length: count }, () => ({
        value_sats: valueEach,
        script_pubkey: SPK_P2WPKH(0xaa),
    }));
}

/** Build a TxEntry (the element of BlockEntry.transactions). */
function makeTxEntry({
    txid = 'aa'.repeat(32),
    inputs = 1,
    values = [100_000, 50_000],
    prevoutValue = 200_000,
    heuristics = noopHeuristics(),
    classification = 'simple_payment',
} = {}) {
    return {
        tx: makeTx({ txid, inputs, values }),
        prevouts: makePrevouts(inputs, prevoutValue),
        heuristics,
        classification,
    };
}

/** Build a BlockEntry. */
function makeBlock({
    block_hash = 'bb'.repeat(32),
    block_height = 800_000,
    txEntries = [makeTxEntry()],
} = {}) {
    return { block_hash, block_height, transactions: txEntries };
}

// ── Suite: buildReport — top-level structure ──────────────────────────────────

describe('buildReport — top-level structure', () => {
    const report = buildReport('blk04330.dat', [makeBlock()]);

    it('ok is true', () => assert.equal(report.ok, true));

    it('mode is "chain_analysis"', () => assert.equal(report.mode, 'chain_analysis'));

    it('file matches the passed filename', () =>
        assert.equal(report.file, 'blk04330.dat'));

    it('block_count equals blocks.length', () =>
        assert.equal(report.block_count, report.blocks.length));

    it('has analysis_summary object', () =>
        assert.equal(typeof report.analysis_summary, 'object'));

    it('has blocks array', () => assert.ok(Array.isArray(report.blocks)));
});

// ── Suite: buildReport — analysis_summary at file level ───────────────────────

describe('buildReport — file-level analysis_summary', () => {
    const b1 = makeBlock({
        block_hash: 'aa'.repeat(32),
        txEntries: [
            makeTxEntry({ txid: '01'.repeat(32) }),
            makeTxEntry({ txid: '02'.repeat(32) }),
        ],
    });
    const b2 = makeBlock({
        block_hash: 'bb'.repeat(32),
        txEntries: [
            makeTxEntry({ txid: '03'.repeat(32) }),
        ],
    });
    const report = buildReport('blk04330.dat', [b1, b2]);
    const s = report.analysis_summary;

    it('total_transactions_analyzed equals sum of tx_counts', () =>
        assert.equal(s.total_transactions_analyzed, 3));

    it('heuristics_applied is an array', () =>
        assert.ok(Array.isArray(s.heuristics_applied)));

    it('heuristics_applied contains at least 5 entries', () =>
        assert.ok(s.heuristics_applied.length >= 5,
            `only ${s.heuristics_applied.length} heuristics: ${s.heuristics_applied}`));

    it('heuristics_applied includes "cioh"', () =>
        assert.ok(s.heuristics_applied.includes('cioh')));

    it('heuristics_applied includes "change_detection"', () =>
        assert.ok(s.heuristics_applied.includes('change_detection')));

    it('flagged_transactions is a non-negative integer', () => {
        assert.ok(Number.isInteger(s.flagged_transactions));
        assert.ok(s.flagged_transactions >= 0);
    });

    it('flagged_transactions equals sum of per-block flagged counts', () => {
        const perBlockSum = report.blocks.reduce(
            (acc, b) => acc + b.analysis_summary.flagged_transactions, 0
        );
        assert.equal(s.flagged_transactions, perBlockSum);
    });

    it('script_type_distribution has all seven script-type keys', () => {
        const keys = ['p2wpkh', 'p2tr', 'p2sh', 'p2pkh', 'p2wsh', 'op_return', 'unknown'];
        for (const k of keys) {
            assert.ok(k in s.script_type_distribution,
                `missing key '${k}' in script_type_distribution`);
        }
    });

    it('fee_rate_stats has min, max, median, mean', () => {
        const fee = s.fee_rate_stats;
        for (const k of ['min_sat_vb', 'max_sat_vb', 'median_sat_vb', 'mean_sat_vb']) {
            assert.ok(typeof fee[k] === 'number', `fee_rate_stats.${k} must be a number`);
        }
    });

    it('fee_rate_stats: min ≤ median ≤ max', () => {
        const { min_sat_vb, median_sat_vb, max_sat_vb } = s.fee_rate_stats;
        assert.ok(min_sat_vb <= median_sat_vb,
            `min (${min_sat_vb}) > median (${median_sat_vb})`);
        assert.ok(median_sat_vb <= max_sat_vb,
            `median (${median_sat_vb}) > max (${max_sat_vb})`);
    });

    it('fee_rate_stats: all values are non-negative', () => {
        const fee = s.fee_rate_stats;
        for (const k of ['min_sat_vb', 'max_sat_vb', 'median_sat_vb', 'mean_sat_vb']) {
            assert.ok(fee[k] >= 0, `fee_rate_stats.${k} is negative`);
        }
    });
});

// ── Suite: buildReport — per-block fields ─────────────────────────────────────

describe('buildReport — per-block fields', () => {
    const txEntries = [
        makeTxEntry({ txid: '01'.repeat(32) }),
        makeTxEntry({ txid: '02'.repeat(32) }),
    ];
    const report = buildReport('blkXX.dat', [makeBlock({ block_hash: 'ab'.repeat(32), block_height: 100, txEntries })]);
    const block = report.blocks[0];

    it('block_hash is preserved', () => assert.equal(block.block_hash, 'ab'.repeat(32)));

    it('block_height is preserved', () => assert.equal(block.block_height, 100));

    it('tx_count equals transactions.length', () =>
        assert.equal(block.tx_count, block.transactions.length));

    it('per-block total_transactions_analyzed equals tx_count', () =>
        assert.equal(block.analysis_summary.total_transactions_analyzed, block.tx_count));

    it('per-block transactions array length matches tx_count', () =>
        assert.equal(block.transactions.length, 2));

    it('per-block analysis_summary has fee_rate_stats', () => {
        const fee = block.analysis_summary.fee_rate_stats;
        for (const k of ['min_sat_vb', 'max_sat_vb', 'median_sat_vb', 'mean_sat_vb']) {
            assert.ok(typeof fee[k] === 'number');
        }
    });
});

// ── Suite: buildReport — per-transaction fields ───────────────────────────────

describe('buildReport — per-transaction fields', () => {
    const VALID_CLASSIFICATIONS = new Set([
        'simple_payment', 'consolidation', 'coinjoin',
        'self_transfer', 'batch_payment', 'unknown',
    ]);

    const entry = makeTxEntry({
        txid: '1a'.repeat(32),
        classification: 'simple_payment',
        heuristics: noopHeuristics(),
    });
    const report = buildReport('blk.dat', [makeBlock({ txEntries: [entry] })]);
    const tx = report.blocks[0].transactions[0];

    it('txid is present and is a 64-char hex string', () => {
        assert.equal(typeof tx.txid, 'string');
        assert.equal(tx.txid.length, 64);
    });

    it('heuristics object is present', () =>
        assert.equal(typeof tx.heuristics, 'object'));

    it('each heuristic result has a detected boolean', () => {
        for (const [id, result] of Object.entries(tx.heuristics)) {
            assert.equal(typeof result.detected, 'boolean',
                `heuristics.${id}.detected must be boolean`);
        }
    });

    it('classification is a valid enum value', () =>
        assert.ok(VALID_CLASSIFICATIONS.has(tx.classification),
            `unexpected classification '${tx.classification}'`));
});

// ── Suite: buildReport — flagged_transactions accuracy ───────────────────────

describe('buildReport — flagged_transactions accuracy', () => {
    // 2 detected, 1 not
    const detected = noopHeuristics({ cioh: { detected: true, input_count: 3, confidence: 0.85 } });
    const txEntries = [
        makeTxEntry({ txid: '01'.repeat(32), heuristics: detected }),
        makeTxEntry({ txid: '02'.repeat(32), heuristics: detected }),
        makeTxEntry({ txid: '03'.repeat(32), heuristics: noopHeuristics() }),
    ];
    const report = buildReport('blkT.dat', [makeBlock({ txEntries })]);

    it('per-block flagged_transactions is 2', () =>
        assert.equal(report.blocks[0].analysis_summary.flagged_transactions, 2));

    it('file-level flagged_transactions is 2', () =>
        assert.equal(report.analysis_summary.flagged_transactions, 2));
});

// ── Suite: buildReport — coinbase-only block uses zero fee stats ──────────────

describe('buildReport — coinbase-only block (fee stats fallback)', () => {
    const coinbaseTx = makeCoinbaseTx();
    const block = makeBlock({
        txEntries: [{
            tx: coinbaseTx,
            prevouts: [],
            heuristics: {
                cioh: { detected: false }, change_detection: { detected: false },
                coinjoin: { detected: false }, consolidation: { detected: false },
                address_reuse: { detected: false }, round_number_payment: { detected: false }
            },
            classification: 'unknown',
        }],
    });
    const report = buildReport('blkCB.dat', [block]);
    const fee = report.analysis_summary.fee_rate_stats;

    it('min_sat_vb is 0 when only coinbase tx present', () => assert.equal(fee.min_sat_vb, 0));
    it('max_sat_vb is 0 when only coinbase tx present', () => assert.equal(fee.max_sat_vb, 0));
    it('median_sat_vb is 0 when only coinbase tx present', () => assert.equal(fee.median_sat_vb, 0));
    it('mean_sat_vb is 0 when only coinbase tx present', () => assert.equal(fee.mean_sat_vb, 0));
});

// ── Suite: buildReport — empty blocks array ───────────────────────────────────

describe('buildReport — empty blocks array', () => {
    const report = buildReport('blkEmpty.dat', []);

    it('ok is true', () => assert.equal(report.ok, true));
    it('block_count is 0', () => assert.equal(report.block_count, 0));
    it('blocks is an empty array', () => assert.deepEqual(report.blocks, []));
    it('total_transactions_analyzed is 0', () =>
        assert.equal(report.analysis_summary.total_transactions_analyzed, 0));
    it('flagged_transactions is 0', () =>
        assert.equal(report.analysis_summary.flagged_transactions, 0));
});

// ── Suite: buildReport — script_type_distribution counts ─────────────────────

describe('buildReport — script_type_distribution counts', () => {
    const entry = {
        tx: {
            txid: '11'.repeat(32),
            vin: [{ prev_txid: 'ff'.repeat(32), vout: 0, scriptSig: '', sequence: 0xffffffff }],
            vout: [
                { value_sats: 100_000, scriptPubKey: SPK_P2WPKH(0x01) },  // p2wpkh
                { value_sats: 200_000, scriptPubKey: SPK_P2PKH(0x02) },  // p2pkh
                { value_sats: 0, scriptPubKey: SPK_OP_RET },  // op_return
            ],
            size: 250,
            segwit: false,
        },
        prevouts: makePrevouts(1, 400_000),
        heuristics: noopHeuristics(),
        classification: 'batch_payment',
    };

    const report = buildReport('blkScript.dat', [makeBlock({ txEntries: [entry] })]);
    const dist = report.analysis_summary.script_type_distribution;

    it('p2wpkh count is 1', () => assert.equal(dist.p2wpkh, 1));
    it('p2pkh count is 1', () => assert.equal(dist.p2pkh, 1));
    it('op_return count is 1', () => assert.equal(dist.op_return, 1));
    it('p2tr count is 0', () => assert.equal(dist.p2tr, 0));
    it('p2sh count is 0', () => assert.equal(dist.p2sh, 0));
    it('p2wsh count is 0', () => assert.equal(dist.p2wsh, 0));
    it('unknown count is 0', () => assert.equal(dist.unknown, 0));
});

// ── Suite: buildReport — fee stats are correct ───────────────────────────────

describe('buildReport — fee_rate_stats correctness', () => {
    // 1-input tx, prevout 200k sat, outputs total 150k sat → fee 50k sat
    // vsize = 250 (legacy, segwit=false) → rate = 50000/250 = 200 sat/vbyte
    const entry = makeTxEntry({ inputs: 1, values: [150_000], prevoutValue: 200_000 });
    const report = buildReport('blkFee.dat', [makeBlock({ txEntries: [entry] })]);
    const fee = report.analysis_summary.fee_rate_stats;

    it('min equals max for single transaction', () =>
        assert.equal(fee.min_sat_vb, fee.max_sat_vb));

    it('computed fee rate is 200 sat/vbyte', () =>
        assert.equal(fee.min_sat_vb, 200));

    it('median equals mean for single transaction', () =>
        assert.equal(fee.median_sat_vb, fee.mean_sat_vb));
});

// ── Suite: buildReport — two-block aggregation ───────────────────────────────

describe('buildReport — two-block aggregation', () => {
    const b1 = makeBlock({
        txEntries: [
            makeTxEntry({ txid: '01'.repeat(32) }),
            makeTxEntry({ txid: '02'.repeat(32) }),
        ],
    });
    const b2 = makeBlock({
        txEntries: [
            makeTxEntry({ txid: '03'.repeat(32) }),
            makeTxEntry({ txid: '04'.repeat(32) }),
            makeTxEntry({ txid: '05'.repeat(32) }),
        ],
    });
    const report = buildReport('blkAgg.dat', [b1, b2]);

    it('block_count is 2', () => assert.equal(report.block_count, 2));

    it('total_transactions_analyzed is 5', () =>
        assert.equal(report.analysis_summary.total_transactions_analyzed, 5));

    it('script_type_distribution sums correctly across both blocks', () => {
        const b1Dist = report.blocks[0].analysis_summary.script_type_distribution;
        const b2Dist = report.blocks[1].analysis_summary.script_type_distribution;
        const combined = report.analysis_summary.script_type_distribution;
        for (const k of Object.keys(combined)) {
            assert.equal(combined[k], (b1Dist[k] ?? 0) + (b2Dist[k] ?? 0),
                `mismatch for key '${k}'`);
        }
    });
});

// ── Suite: generateJsonReport — file I/O ─────────────────────────────────────

describe('generateJsonReport — file I/O', () => {
    // Use a dedicated temp directory per test run
    const tmpDir = path.join(os.tmpdir(), `jsonReport-test-${crypto.randomUUID()}`);

    after(async () => {
        // Clean up temp directory after this suite
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('creates the output directory if absent and writes valid JSON', async () => {
        const outDir = path.join(tmpDir, 'out1');
        const blkPath = path.join('/fake', 'blk04330.dat');
        const report = await generateJsonReport(blkPath, [makeBlock()], { outDir });

        const outFile = path.join(outDir, 'blk04330.json');
        const raw = await fs.readFile(outFile, 'utf-8');
        const parsed = JSON.parse(raw);

        assert.equal(parsed.ok, true);
        assert.equal(parsed.file, 'blk04330.dat');
        assert.deepEqual(parsed, report);
    });

    it('returns the report object', async () => {
        const outDir = path.join(tmpDir, 'out2');
        const result = await generateJsonReport(
            '/fake/blk99999.dat', [makeBlock()], { outDir }
        );
        assert.equal(result.ok, true);
        assert.equal(result.file, 'blk99999.dat');
        assert.equal(result.block_count, 1);
    });

    it('stem strips .dat extension (case-insensitive)', async () => {
        const outDir = path.join(tmpDir, 'out3');
        await generateJsonReport('/fake/blkMixed.DAT', [makeBlock()], { outDir });
        const files = await fs.readdir(outDir);
        assert.ok(files.includes('blkMixed.json'),
            `expected blkMixed.json, got ${files}`);
    });

    it('overwrites an existing file without error', async () => {
        const outDir = path.join(tmpDir, 'out4');
        await generateJsonReport('/fake/blk00001.dat', [makeBlock()], { outDir });
        // Second call — should not throw
        const report = await generateJsonReport('/fake/blk00001.dat', [makeBlock()], { outDir });
        assert.equal(report.ok, true);
    });
});
