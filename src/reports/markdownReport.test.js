/**
 * src/reports/markdownReport.test.js
 *
 * Tests for markdownReport.js.
 *
 * Run:  node --test src/reports/markdownReport.test.js
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { buildMarkdown, generateMarkdownReport } from './markdownReport.js';

// ── Test-data helpers ─────────────────────────────────────────────────────────

const NULL_TXID = '0'.repeat(64);
const SPK_P2WPKH = (seed = 0xab) => '0014' + seed.toString(16).padStart(2, '0').repeat(20);
const SPK_P2PKH = (seed = 0xcd) =>
    '76a914' + seed.toString(16).padStart(2, '0').repeat(20) + '88ac';

function makeTx({ txid = 'aa'.repeat(32), inputs = 1, values = [100_000, 50_000] } = {}) {
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
        segwit: false,
    };
}

function makeCoinbaseTx() {
    return {
        txid: '00'.repeat(32),
        vin: [{ prev_txid: NULL_TXID, vout: 0xffffffff, scriptSig: '', sequence: 0xffffffff }],
        vout: [{ value_sats: 625_000_000, scriptPubKey: SPK_P2WPKH(0xff) }],
        size: 120,
        segwit: false,
    };
}

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
        prevouts: Array.from({ length: inputs }, () => ({ value_sats: prevoutValue, script_pubkey: SPK_P2WPKH(0xaa) })),
        heuristics,
        classification,
    };
}

function makeBlock({
    block_hash = 'bb'.repeat(32),
    block_height = 800_000,
    timestamp = 1_700_000_000,
    txEntries = [makeTxEntry()],
} = {}) {
    return { block_hash, block_height, timestamp, transactions: txEntries };
}

// ── Suite: buildMarkdown — basic structure ────────────────────────────────────

describe('buildMarkdown — basic structure', () => {
    const md = buildMarkdown('blk04330.dat', [makeBlock()]);

    it('returns a string', () => assert.equal(typeof md, 'string'));

    it('is at least 1 KB', () =>
        assert.ok(Buffer.byteLength(md, 'utf-8') >= 1024,
            `report is only ${Buffer.byteLength(md, 'utf-8')} bytes`));

    it('contains the filename in a heading', () =>
        assert.ok(md.includes('blk04330.dat'), 'filename missing from report'));

    it('starts with a level-1 heading', () =>
        assert.ok(md.trimStart().startsWith('# '), 'first line must be an H1'));

    it('contains a Table of Contents section', () =>
        assert.ok(md.includes('Table of Contents'), 'ToC section missing'));

    it('contains a File Overview section', () =>
        assert.ok(md.includes('## File Overview'), 'File Overview heading missing'));

    it('contains a Summary Statistics section', () =>
        assert.ok(md.includes('## Summary Statistics'), 'Summary Statistics heading missing'));

    it('contains a per-block section heading', () =>
        assert.ok(md.includes('## Block 1'), 'per-block heading missing'));
});

// ── Suite: buildMarkdown — Markdown table presence ───────────────────────────

describe('buildMarkdown — Markdown tables', () => {
    const md = buildMarkdown('blkT.dat', [makeBlock()]);

    it('contains at least one Markdown table separator row', () =>
        assert.ok(/^\|[-| ]+\|$/m.test(md), 'no table separator row found'));

    it('contains fee rate distribution table', () =>
        assert.ok(md.includes('Fee Rate Distribution') || md.includes('sat/vbyte'),
            'fee rate section missing'));

    it('contains script type breakdown table content', () => {
        assert.ok(md.includes('p2wpkh'), 'p2wpkh row missing from script distribution');
        assert.ok(md.includes('p2pkh'), 'p2pkh row missing from script distribution');
    });

    it('contains heuristic findings table headers', () =>
        assert.ok(
            md.includes('Heuristic') && md.includes('Flagged'),
            'heuristic findings table missing'
        ));
});

// ── Suite: buildMarkdown — heuristic IDs appear in report ────────────────────

describe('buildMarkdown — heuristic IDs', () => {
    const md = buildMarkdown('blkH.dat', [makeBlock()]);

    for (const id of ['cioh', 'change_detection', 'coinjoin', 'consolidation',
        'address_reuse', 'round_number_payment']) {
        it(`heuristic id "${id}" appears in the report`, () =>
            assert.ok(md.includes(id), `"${id}" not found in report`));
    }
});

// ── Suite: buildMarkdown — flagged transactions reflected ─────────────────────

describe('buildMarkdown — flagged transactions', () => {
    const detected = noopHeuristics({
        cioh: { detected: true, input_count: 3, confidence: 0.85 },
    });
    const txEntries = [
        makeTxEntry({ txid: '01'.repeat(32), heuristics: detected, classification: 'simple_payment' }),
        makeTxEntry({ txid: '02'.repeat(32), heuristics: detected, classification: 'simple_payment' }),
        makeTxEntry({ txid: '03'.repeat(32), heuristics: noopHeuristics(), classification: 'simple_payment' }),
    ];
    const md = buildMarkdown('blkF.dat', [makeBlock({ txEntries })]);

    it('shows "2" as the flagged transaction count', () => {
        // The overview table row "Flagged transactions | 2"
        assert.ok(/Flagged.*\|\s*2\b/.test(md) || md.includes('| 2 |') || md.includes('| 2\n'),
            `flagged count "2" not found in report\n---\n${md.slice(0, 500)}`);
    });
});

// ── Suite: buildMarkdown — notable transactions ───────────────────────────────

describe('buildMarkdown — notable transactions', () => {
    const cjHeuristics = noopHeuristics({
        coinjoin: { detected: true, equal_output_count: 5, denomination_sats: 100_000 },
    });
    const cjEntry = makeTxEntry({
        txid: 'de'.repeat(32),
        inputs: 6,
        values: [100_000, 100_000, 100_000, 100_000, 100_000, 50_000],
        heuristics: cjHeuristics,
        classification: 'coinjoin',
    });
    const md = buildMarkdown('blkN.dat', [makeBlock({ txEntries: [cjEntry] })]);

    it('notable transactions section is present', () =>
        assert.ok(md.includes('Notable Transactions'), 'notable section missing'));

    it('coinjoin classification appears in notable table', () =>
        assert.ok(md.includes('coinjoin'), 'coinjoin not mentioned in report'));

    it('short txid of coinjoin tx appears', () =>
        // shortTxid('de'.repeat(32)) = 'dededede…dededede'
        assert.ok(md.includes('dededede'), 'coinjoin txid prefix not found'));
});

// ── Suite: buildMarkdown — consolidation detail ───────────────────────────────

describe('buildMarkdown — consolidation detail', () => {
    const conHeuristics = noopHeuristics({
        consolidation: { detected: true, input_count: 9, output_count: 2, ratio: 4.5 },
    });
    const conEntry = makeTxEntry({
        txid: 'cc'.repeat(32),
        inputs: 9,
        values: [400_000, 200_000],
        heuristics: conHeuristics,
        classification: 'consolidation',
    });
    const md = buildMarkdown('blkC.dat', [makeBlock({ txEntries: [conEntry] })]);

    it('consolidation classification appears', () =>
        assert.ok(md.includes('consolidation'), 'consolidation not in report'));

    it('ratio detail 4.5 appears', () =>
        assert.ok(md.includes('4.5'), 'consolidation ratio not in report'));
});

// ── Suite: buildMarkdown — empty blocks array ─────────────────────────────────

describe('buildMarkdown — empty blocks array', () => {
    const md = buildMarkdown('blkEmpty.dat', []);

    it('is still at least 1 KB', () =>
        assert.ok(Buffer.byteLength(md, 'utf-8') >= 1024,
            `empty report is only ${Buffer.byteLength(md, 'utf-8')} bytes`));

    it('still contains File Overview section', () =>
        assert.ok(md.includes('## File Overview'), 'File Overview missing for empty input'));

    it('still contains Summary Statistics section', () =>
        assert.ok(md.includes('## Summary Statistics'), 'Summary Statistics missing for empty input'));
});

// ── Suite: buildMarkdown — coinbase-only block ────────────────────────────────

describe('buildMarkdown — coinbase-only block', () => {
    const coinbaseEntry = {
        tx: makeCoinbaseTx(),
        prevouts: [],
        heuristics: noopHeuristics(),
        classification: 'unknown',
    };
    const md = buildMarkdown('blkCB.dat', [makeBlock({ txEntries: [coinbaseEntry] })]);

    it('is at least 1 KB', () =>
        assert.ok(Buffer.byteLength(md, 'utf-8') >= 1024));

    it('includes block heading', () =>
        assert.ok(md.includes('## Block 1'), 'block heading missing'));
});

// ── Suite: buildMarkdown — multi-block file ───────────────────────────────────

describe('buildMarkdown — multi-block file', () => {
    const blocks = [
        makeBlock({ block_hash: 'aa'.repeat(32), block_height: 100, txEntries: [makeTxEntry({ txid: '01'.repeat(32) })] }),
        makeBlock({ block_hash: 'bb'.repeat(32), block_height: 101, txEntries: [makeTxEntry({ txid: '02'.repeat(32) })] }),
        makeBlock({ block_hash: 'cc'.repeat(32), block_height: 102, txEntries: [makeTxEntry({ txid: '03'.repeat(32) })] }),
    ];
    const md = buildMarkdown('blkMulti.dat', blocks);

    it('contains headings for all 3 blocks', () => {
        assert.ok(md.includes('## Block 1'), 'Block 1 heading missing');
        assert.ok(md.includes('## Block 2'), 'Block 2 heading missing');
        assert.ok(md.includes('## Block 3'), 'Block 3 heading missing');
    });

    it('is at least 1 KB', () =>
        assert.ok(Buffer.byteLength(md, 'utf-8') >= 1024));
});

// ── Suite: generateMarkdownReport — file I/O ─────────────────────────────────

describe('generateMarkdownReport — file I/O', () => {
    const tmpDir = path.join(os.tmpdir(), `mdReport-test-${crypto.randomUUID()}`);

    after(async () => {
        await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('creates output directory and writes file', async () => {
        const outDir = path.join(tmpDir, 'out1');
        const md = await generateMarkdownReport('/fake/blk04330.dat', [makeBlock()], { outDir });
        const outFile = path.join(outDir, 'blk04330.md');
        const written = await fs.readFile(outFile, 'utf-8');
        assert.equal(written, md);
    });

    it('returns the Markdown string', async () => {
        const outDir = path.join(tmpDir, 'out2');
        const md = await generateMarkdownReport('/fake/blk99999.dat', [makeBlock()], { outDir });
        assert.equal(typeof md, 'string');
        assert.ok(md.includes('blk99999.dat'));
    });

    it('stem strips .dat extension', async () => {
        const outDir = path.join(tmpDir, 'out3');
        await generateMarkdownReport('/fake/blkMixed.DAT', [makeBlock()], { outDir });
        const files = await fs.readdir(outDir);
        assert.ok(files.includes('blkMixed.md'), `expected blkMixed.md, got ${files}`);
    });

    it('written file is at least 1 KB', async () => {
        const outDir = path.join(tmpDir, 'out4');
        await generateMarkdownReport('/fake/blk00001.dat', [makeBlock()], { outDir });
        const stat = await fs.stat(path.join(outDir, 'blk00001.md'));
        assert.ok(stat.size >= 1024, `file is only ${stat.size} bytes`);
    });
});
