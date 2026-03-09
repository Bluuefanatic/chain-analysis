/**
 * src/parser/blockParser.test.js
 *
 * Unit tests for blockParser.js using the built-in Node.js test runner
 * (node:test + node:assert).  Compatible with Node.js >= 18 and native ESM.
 *
 * Run:  node --test src/parser/blockParser.test.js
 * Run all:  node --test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    readVarInt,
    measureTx,
    hash256Hex,
    loadXorKey,
    parseBlockFile,
} from './blockParser.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** double-SHA256, bytes reversed → hex string (mirrors the export under test) */
function expectedHash256Hex(buf) {
    const first = createHash('sha256').update(buf).digest();
    const second = createHash('sha256').update(first).digest();
    return Buffer.from(second).reverse().toString('hex');
}

/**
 * Build a minimal legacy (non-SegWit) coinbase transaction buffer.
 *
 * Structure:
 *   version(4) | inCount(1) | input(45) | outCount(1) | output(34) | locktime(4)
 *   Total = 89 bytes
 *
 * The scriptSig is 4 arbitrary bytes.
 * The output is a P2PKH script (25 bytes) paying to an all-zero pubkey hash.
 */
function buildCoinbaseTx() {
    const tx = Buffer.alloc(89, 0x00);
    let o = 0;

    // version: 1 (LE int32)
    tx.writeInt32LE(1, o); o += 4;

    // inCount: 1
    tx[o++] = 0x01;

    // input: prev txid (32 zero bytes) — coinbase marker
    o += 32;
    // input: prev vout = 0xffffffff — coinbase marker
    tx.writeUInt32LE(0xffffffff, o); o += 4;
    // scriptSig length: 4
    tx[o++] = 0x04;
    // scriptSig: 4 arbitrary bytes
    tx[o++] = 0x03; tx[o++] = 0x4a; tx[o++] = 0x04; tx[o++] = 0x1d;
    // sequence: 0xffffffff
    tx.writeUInt32LE(0xffffffff, o); o += 4;

    // outCount: 1
    tx[o++] = 0x01;

    // output value: 50 BTC = 5_000_000_000 satoshis (LE uint64)
    tx.writeBigUInt64LE(5_000_000_000n, o); o += 8;
    // scriptPubKey length: 25 (P2PKH)
    tx[o++] = 25;
    // P2PKH: OP_DUP OP_HASH160 PUSH_20 <20-zero-bytes> OP_EQUALVERIFY OP_CHECKSIG
    tx[o++] = 0x76; tx[o++] = 0xa9; tx[o++] = 0x14;
    o += 20; // 20 zero bytes already present (Buffer.alloc zeros)
    tx[o++] = 0x88; tx[o++] = 0xac;

    // locktime: 0
    tx.writeUInt32LE(0, o); o += 4;

    assert.strictEqual(o, 89, 'buildCoinbaseTx: expected 89 bytes');
    return tx;
}

/**
 * Build a minimal SegWit transaction buffer.
 *
 * Structure:
 *   version(4) | marker(1) | flag(1) | inCount(1) | input(41) |
 *   outCount(1) | output(31) | witness(6) | locktime(4)
 *   Total = 90 bytes
 *
 * The single input has an empty scriptSig (native SegWit).
 * The output is P2WPKH (22-byte scriptPubKey: OP_0 PUSH_20 <20 zero bytes>).
 * The witness for the input contains one 4-byte dummy item.
 */
function buildSegwitTx() {
    const tx = Buffer.alloc(90, 0x00);
    let o = 0;

    // version: 2
    tx.writeInt32LE(2, o); o += 4;

    // SegWit marker + flag
    tx[o++] = 0x00; tx[o++] = 0x01;

    // inCount: 1
    tx[o++] = 0x01;

    // input: prev txid (32 zeros) + prev vout (0)
    o += 32;
    tx.writeUInt32LE(0, o); o += 4;
    // scriptSig length: 0 (native SegWit — script is in witness)
    tx[o++] = 0x00;
    // sequence: 0xffffffff
    tx.writeUInt32LE(0xffffffff, o); o += 4;

    // outCount: 1
    tx[o++] = 0x01;

    // output value: 1 BTC
    tx.writeBigUInt64LE(100_000_000n, o); o += 8;
    // P2WPKH scriptPubKey: OP_0 PUSH_20 <20 zero bytes>  (22 bytes)
    tx[o++] = 22;
    tx[o++] = 0x00; tx[o++] = 0x14;
    o += 20; // 20 zero bytes

    // Witness for input 0: 1 stack item, 4 bytes (dummy signature placeholder)
    tx[o++] = 0x01;   // item count
    tx[o++] = 0x04;   // item length: 4
    o += 4;           // 4 zero bytes (dummy witness data)

    // locktime: 0
    tx.writeUInt32LE(0, o); o += 4;

    assert.strictEqual(o, 90, 'buildSegwitTx: expected 90 bytes');
    return tx;
}

/**
 * Wrap one or more transaction buffers into a complete blk*.dat block message.
 *
 * @param {Buffer[]} txBufs     Raw transaction buffers.
 * @param {number}  [timestamp] Block header timestamp (default: genesis block).
 * @returns {Buffer} Complete block message (magic + size + header + txs).
 */
function buildBlockMessage(txBufs, timestamp = 1231006505) {
    // ── Block header (80 bytes) ──────────────────────────────────────────────
    // version(4) | prev_hash(32) | merkle_root(32) | timestamp(4) | bits(4) | nonce(4)
    const header = Buffer.alloc(80, 0x00);
    header.writeInt32LE(1, 0);              // version
    // prev_hash and merkle_root stay zero
    header.writeUInt32LE(timestamp, 68);    // timestamp at offset 68
    header.writeUInt32LE(0x1d00ffff, 72);   // bits (mainnet genesis)

    // ── tx count varint (single byte for ≤ 252 txs) ─────────────────────────
    const txCountBuf = Buffer.alloc(1);
    txCountBuf[0] = txBufs.length;

    // ── Assemble block payload ────────────────────────────────────────────────
    const blockPayload = Buffer.concat([header, txCountBuf, ...txBufs]);

    // ── Block message envelope ────────────────────────────────────────────────
    const magic = Buffer.alloc(4);
    magic.writeUInt32LE(0xd9b4bef9, 0);  // mainnet magic

    const sizeField = Buffer.alloc(4);
    sizeField.writeUInt32LE(blockPayload.length, 0);

    return Buffer.concat([magic, sizeField, blockPayload]);
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

let tmpDir;

before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'blockparser-test-'));
});

after(() => {
    // Clean up temp files created during the tests.
    rmSync(tmpDir, { recursive: true, force: true });
});

// ── readVarInt ────────────────────────────────────────────────────────────────

describe('readVarInt', () => {
    it('reads a 1-byte varint (value < 0xfd)', () => {
        const buf = Buffer.from([0x05, 0xff]);
        const result = readVarInt(buf, 0);
        assert.deepEqual(result, { value: 5, size: 1 });
    });

    it('reads a 1-byte varint with value 0', () => {
        const buf = Buffer.from([0x00]);
        const result = readVarInt(buf, 0);
        assert.deepEqual(result, { value: 0, size: 1 });
    });

    it('reads a 1-byte varint with maximum 1-byte value (0xfc = 252)', () => {
        const buf = Buffer.from([0xfc]);
        const result = readVarInt(buf, 0);
        assert.deepEqual(result, { value: 252, size: 1 });
    });

    it('reads a 3-byte varint (0xfd prefix)', () => {
        // 0xfd followed by LE uint16: 0x0100 = 256
        const buf = Buffer.from([0xfd, 0x00, 0x01]);
        const result = readVarInt(buf, 0);
        assert.deepEqual(result, { value: 256, size: 3 });
    });

    it('reads a 5-byte varint (0xfe prefix)', () => {
        // 0xfe followed by LE uint32: 0x00010000 = 65536
        const buf = Buffer.from([0xfe, 0x00, 0x00, 0x01, 0x00]);
        const result = readVarInt(buf, 0);
        assert.deepEqual(result, { value: 65536, size: 5 });
    });

    it('reads a 9-byte varint (0xff prefix)', () => {
        // 0xff followed by LE uint64: value 1 (lo=1, hi=0)
        const buf = Buffer.from([0xff, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
        const result = readVarInt(buf, 0);
        assert.deepEqual(result, { value: 1, size: 9 });
    });

    it('reads a varint at a non-zero offset', () => {
        // First 3 bytes are padding; varint starts at offset 3
        const buf = Buffer.from([0xaa, 0xbb, 0xcc, 0x07]);
        const result = readVarInt(buf, 3);
        assert.deepEqual(result, { value: 7, size: 1 });
    });
});

// ── measureTx ────────────────────────────────────────────────────────────────

describe('measureTx', () => {
    it('measures a legacy coinbase transaction', () => {
        const tx = buildCoinbaseTx(); // 89 bytes
        const measured = measureTx(tx, 0);
        assert.strictEqual(measured, 89);
    });

    it('measures a SegWit transaction', () => {
        const tx = buildSegwitTx(); // 90 bytes
        const measured = measureTx(tx, 0);
        assert.strictEqual(measured, 90);
    });

    it('measures a transaction at a non-zero buffer offset', () => {
        const prefix = Buffer.alloc(16, 0xde); // 16 bytes of junk before the tx
        const tx = buildCoinbaseTx();
        const combined = Buffer.concat([prefix, tx]);
        const measured = measureTx(combined, 16);
        assert.strictEqual(measured, 89);
    });
});

// ── hash256Hex ────────────────────────────────────────────────────────────────

describe('hash256Hex', () => {
    it('returns a 64-character lowercase hex string', () => {
        const buf = Buffer.from('hello bitcoin');
        const result = hash256Hex(buf);
        assert.strictEqual(typeof result, 'string');
        assert.strictEqual(result.length, 64);
        assert.match(result, /^[0-9a-f]{64}$/);
    });

    it('produces the correct double-SHA256 with reversed byte order', () => {
        const buf = Buffer.alloc(80, 0x00); // all-zero 80-byte header
        const expected = expectedHash256Hex(buf);
        assert.strictEqual(hash256Hex(buf), expected);
    });

    it('two different inputs produce different hashes', () => {
        const a = Buffer.from([0x01]);
        const b = Buffer.from([0x02]);
        assert.notStrictEqual(hash256Hex(a), hash256Hex(b));
    });
});

// ── parseBlockFile — single block ─────────────────────────────────────────────

describe('parseBlockFile — single legacy-tx block', () => {
    let blkPath;
    let syntheticHeader;
    const TIMESTAMP = 1231006505; // genesis block timestamp

    before(() => {
        const coinbase = buildCoinbaseTx();
        const msg = buildBlockMessage([coinbase], TIMESTAMP);

        blkPath = join(tmpDir, 'blk_single.dat');
        writeFileSync(blkPath, msg);

        // Keep the header bytes so we can compute the expected hash independently.
        // header starts at offset 8 (after magic + size fields)
        syntheticHeader = msg.subarray(8, 88);
    });

    it('returns exactly one block', () => {
        const { blocks } = parseBlockFile(blkPath);
        assert.strictEqual(blocks.length, 1);
    });

    it('block_hash matches double-SHA256 of the 80-byte header (reversed)', () => {
        const { blocks } = parseBlockFile(blkPath);
        const expected = expectedHash256Hex(syntheticHeader);
        assert.strictEqual(blocks[0].block_hash, expected);
    });

    it('timestamp is read from block header bytes 68–71', () => {
        const { blocks } = parseBlockFile(blkPath);
        assert.strictEqual(blocks[0].timestamp, TIMESTAMP);
    });

    it('raw_transactions contains exactly one entry', () => {
        const { blocks } = parseBlockFile(blkPath);
        assert.strictEqual(blocks[0].raw_transactions.length, 1);
    });

    it('raw transaction bytes match the original coinbase buffer exactly', () => {
        const coinbase = buildCoinbaseTx();
        const { blocks } = parseBlockFile(blkPath);
        assert.deepEqual(blocks[0].raw_transactions[0], coinbase);
    });

    it('raw transaction is an independent Buffer copy (not a view)', () => {
        const { blocks } = parseBlockFile(blkPath);
        const rawTx = blocks[0].raw_transactions[0];
        // Mutating the returned buffer must not affect a subsequent parse.
        rawTx.fill(0xff);
        const { blocks: blocks2 } = parseBlockFile(blkPath);
        assert.notDeepEqual(blocks2[0].raw_transactions[0], rawTx);
    });
});

// ── parseBlockFile — SegWit tx ────────────────────────────────────────────────

describe('parseBlockFile — block with SegWit transaction', () => {
    let blkPath;

    before(() => {
        const segwitTx = buildSegwitTx();
        const msg = buildBlockMessage([segwitTx]);
        blkPath = join(tmpDir, 'blk_segwit.dat');
        writeFileSync(blkPath, msg);
    });

    it('correctly measures and extracts the SegWit transaction bytes', () => {
        const expected = buildSegwitTx();
        const { blocks } = parseBlockFile(blkPath);
        assert.strictEqual(blocks[0].raw_transactions.length, 1);
        assert.deepEqual(blocks[0].raw_transactions[0], expected);
    });
});

// ── parseBlockFile — multiple blocks in one file ──────────────────────────────

describe('parseBlockFile — multiple blocks in one file', () => {
    let blkPath;
    const TS_A = 1231006505;
    const TS_B = 1231469665;

    before(() => {
        const msgA = buildBlockMessage([buildCoinbaseTx()], TS_A);
        const msgB = buildBlockMessage([buildCoinbaseTx(), buildCoinbaseTx()], TS_B);

        blkPath = join(tmpDir, 'blk_multi.dat');
        writeFileSync(blkPath, Buffer.concat([msgA, msgB]));
    });

    it('returns two blocks', () => {
        const { blocks } = parseBlockFile(blkPath);
        assert.strictEqual(blocks.length, 2);
    });

    it('first block has 1 transaction', () => {
        const { blocks } = parseBlockFile(blkPath);
        assert.strictEqual(blocks[0].raw_transactions.length, 1);
    });

    it('second block has 2 transactions', () => {
        const { blocks } = parseBlockFile(blkPath);
        assert.strictEqual(blocks[1].raw_transactions.length, 2);
    });

    it('timestamps are correct for each block', () => {
        const { blocks } = parseBlockFile(blkPath);
        assert.strictEqual(blocks[0].timestamp, TS_A);
        assert.strictEqual(blocks[1].timestamp, TS_B);
    });

    it('each block has a distinct hash', () => {
        const { blocks } = parseBlockFile(blkPath);
        assert.notStrictEqual(blocks[0].block_hash, blocks[1].block_hash);
    });
});

// ── parseBlockFile — XOR obfuscation ─────────────────────────────────────────

describe('parseBlockFile — XOR obfuscated file', () => {
    let blkPath;
    let xorPath;
    const XOR_KEY = Buffer.from([0x2a, 0x7f, 0x13, 0xde, 0x88, 0x04, 0x55, 0xc1]);

    before(() => {
        const plainMsg = buildBlockMessage([buildCoinbaseTx()]);

        // XOR each byte with the key at the corresponding position
        const obfuscated = Buffer.from(plainMsg);
        for (let i = 0; i < obfuscated.length; i++) {
            obfuscated[i] ^= XOR_KEY[i % XOR_KEY.length];
        }

        blkPath = join(tmpDir, 'blk_xor.dat');
        xorPath = join(tmpDir, 'xor.dat');
        writeFileSync(blkPath, obfuscated);
        writeFileSync(xorPath, XOR_KEY);
    });

    it('loadXorKey returns the key buffer', () => {
        const key = loadXorKey(xorPath);
        assert.deepEqual(key, XOR_KEY);
    });

    it('loadXorKey returns null for an all-zero key', () => {
        const zeroPath = join(tmpDir, 'xor_zero.dat');
        writeFileSync(zeroPath, Buffer.alloc(8, 0));
        assert.strictEqual(loadXorKey(zeroPath), null);
    });

    it('parsing with the XOR key deobfuscates and reads correctly', () => {
        const key = loadXorKey(xorPath);
        const { blocks } = parseBlockFile(blkPath, key);
        assert.strictEqual(blocks.length, 1);
        assert.strictEqual(blocks[0].raw_transactions.length, 1);
        assert.deepEqual(blocks[0].raw_transactions[0], buildCoinbaseTx());
    });

    it('parsing without the XOR key throws (magic mismatch)', () => {
        assert.throws(
            () => parseBlockFile(blkPath),
            /unexpected magic/i
        );
    });
});

// ── parseBlockFile — error handling ───────────────────────────────────────────

describe('parseBlockFile — error handling', () => {
    it('throws on wrong magic bytes', () => {
        // Build a message but corrupt the magic
        const msg = buildBlockMessage([buildCoinbaseTx()]);
        msg.writeUInt32LE(0xdeadbeef, 0); // overwrite magic

        const p = join(tmpDir, 'blk_badmagic.dat');
        writeFileSync(p, msg);

        assert.throws(() => parseBlockFile(p), /unexpected magic/i);
    });

    it('throws when block size exceeds file length', () => {
        // Build a valid message then truncate it
        const msg = buildBlockMessage([buildCoinbaseTx()]);
        const truncated = msg.subarray(0, msg.length - 10); // chop last 10 bytes

        const p = join(tmpDir, 'blk_truncated.dat');
        writeFileSync(p, truncated);

        assert.throws(() => parseBlockFile(p), /claims size|truncated/i);
    });
});
