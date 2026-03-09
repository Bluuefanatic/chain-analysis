/**
 * src/parser/revParser.test.js
 *
 * Unit tests for revParser.js using the Node.js built-in test runner.
 *
 * Run single file:  node --test src/parser/revParser.test.js
 * Run all tests:    node --test
 *
 * All tests are self-contained: synthetic rev.dat buffers are constructed
 * programmatically using the same encoding algorithms as Bitcoin Core, so
 * no external fixture files are required.
 *
 * Test data construction helpers
 * ───────────────────────────────
 * encodeCVarInt(v)         — encode a CVarInt (inverse of readCVarInt)
 * compressAmount(n)        — encode satoshi amount (inverse of decompressAmount)
 * makeP2pkhScript(h160)    — 21-byte compressed P2PKH coin script
 * makeP2shScript(h160)     — 21-byte compressed P2SH coin script
 * makeCompressedPkScript(t,x) — 33-byte compressed P2PK coin script
 * makeRawScript(hex)       — non-special CVarInt-prefixed coin script
 * makeCoin(opts)           — full coin entry bytes
 * makeBlockUndo(txUndos)   — CBlockUndo bytes
 * makeRevRecord(blkUndoBuf)— one magic+size+undo+checksum record
 * makeRevFile(blocks)      — complete rev.dat buffer from an array of block undo specs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join }    from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';

import {
    readCVarInt,
    decompressAmount,
    decompressScript,
    parseRevFile,
    resolvePrevouts,
} from './revParser.js';

// ---------------------------------------------------------------------------
// Test-only encoding helpers
// ---------------------------------------------------------------------------

/**
 * Encode a non-negative integer as a Bitcoin Core CVarInt.
 * This is the inverse of readCVarInt.
 *
 * Encoding algorithm (from Bitcoin Core serialize.h):
 *   1. Write the low 7 bits with no continuation marker (len=0 → bit7 = 0).
 *   2. If more bits remain, shift right 7 and subtract 1 (the encoding bias),
 *      then write the next 7 bits with the continuation bit set (bit7 = 1).
 *   3. Bytes are accumulated from LSB-chunk first, then reversed for output
 *      so the result is big-endian.
 *
 * @param {number} v  Non-negative integer.
 * @returns {Buffer}
 */
function encodeCVarInt(v) {
    const tmp = [];
    let len = 0;
    do {
        // len > 0 → set continuation bit on earlier (more-significant) bytes
        tmp.push((v & 0x7F) | (len > 0 ? 0x80 : 0x00));
        if (v <= 0x7F) break;
        v = Math.floor(v >>> 7) - 1; // strip 7 bits + encoding bias
        len++;
    } while (true);
    return Buffer.from(tmp.reverse());
}

/**
 * Compress a satoshi amount using Bitcoin Core's CompressAmount algorithm.
 * This is the inverse of decompressAmount.
 *
 * @param {number} n  Satoshi amount (non-negative integer).
 * @returns {number}  Compressed value for CVarInt encoding.
 */
function compressAmount(n) {
    if (n === 0) return 0;
    let e = 0;
    while ((n % 10) === 0 && e < 9) {
        n = Math.floor(n / 10);
        e++;
    }
    if (e < 9) {
        const d = n % 10;
        n = Math.floor(n / 10);
        return 1 + (n * 9 + d - 1) * 10 + e;
    } else {
        return 1 + (n - 1) * 10 + 9;
    }
}

/** 21-byte compressed P2PKH coin script: [0x00, 20-byte hash160]. */
function makeP2pkhScript(hash160Hex) {
    assert.strictEqual(hash160Hex.length, 40, 'P2PKH hash160 must be 20 bytes (40 hex chars)');
    return Buffer.concat([Buffer.from([0x00]), Buffer.from(hash160Hex, 'hex')]);
}

/** 21-byte compressed P2SH coin script: [0x01, 20-byte hash160]. */
function makeP2shScript(hash160Hex) {
    assert.strictEqual(hash160Hex.length, 40, 'P2SH hash160 must be 20 bytes (40 hex chars)');
    return Buffer.concat([Buffer.from([0x01]), Buffer.from(hash160Hex, 'hex')]);
}

/**
 * 33-byte compressed P2PK coin script: [type, 32-byte x-coord].
 * type must be 0x02 or 0x03 (compressed pubkey prefix).
 */
function makeCompressedPkScript(type, xCoordHex) {
    assert.ok(type === 0x02 || type === 0x03, 'P2PK type must be 0x02 or 0x03');
    assert.strictEqual(xCoordHex.length, 64, 'x-coord must be 32 bytes (64 hex chars)');
    return Buffer.concat([Buffer.from([type]), Buffer.from(xCoordHex, 'hex')]);
}

/**
 * Non-special compressed script: CVarInt(script_len + 6) + raw script bytes.
 * Used for P2WPKH, P2WSH, P2TR, and any other non-standard script type.
 */
function makeRawScript(scriptHex) {
    const raw = Buffer.from(scriptHex, 'hex');
    const lenCode = raw.length + 6;
    return Buffer.concat([encodeCVarInt(lenCode), raw]);
}

/**
 * Build a full coin entry: [CVarInt(code)] [CVarInt(compressed_amount)] [script_bytes].
 *
 * @param {{
 *   height:       number,
 *   is_coinbase?: boolean,
 *   value_sats:   number,
 *   scriptBuf:    Buffer   — already-compressed script bytes (from makeP2pkhScript etc.)
 * }} opts
 * @returns {Buffer}
 */
function makeCoin({ height, is_coinbase = false, value_sats, scriptBuf }) {
    const code = (height * 2) + (is_coinbase ? 1 : 0);
    return Buffer.concat([
        encodeCVarInt(code),
        encodeCVarInt(compressAmount(value_sats)),
        scriptBuf,
    ]);
}

/**
 * Serialize a CBlockUndo: CVarInt(txCount) then for each tx:
 * CVarInt(inputCount) + coin entries.
 *
 * @param {Array<Array<Buffer>>} txUndos
 *   Outer array: one element per non-coinbase transaction.
 *   Inner array: coin Buffers for each input of that transaction.
 * @returns {Buffer}
 */
function makeBlockUndo(txUndos) {
    const parts = [encodeCVarInt(txUndos.length)];
    for (const coins of txUndos) {
        parts.push(encodeCVarInt(coins.length));
        for (const coinBuf of coins) {
            parts.push(coinBuf);
        }
    }
    return Buffer.concat(parts);
}

/**
 * Wrap a CBlockUndo buffer in the rev.dat record envelope:
 * [magic 4B][size 4B][blockUndoBuf][checksum 32B].
 * size = blockUndoBuf.length + 32 (checksum counted in size).
 *
 * @param {Buffer} blockUndoBuf
 * @returns {Buffer}
 */
function makeRevRecord(blockUndoBuf) {
    const checksum = Buffer.alloc(32); // 32 zero bytes — dummy for tests
    const size = blockUndoBuf.length + 32;
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32LE(0xd9b4bef9, 0); // mainnet magic
    header.writeUInt32LE(size, 4);
    return Buffer.concat([header, blockUndoBuf, checksum]);
}

/** Build a complete rev.dat buffer from an array of per-block txUndo specs. */
function makeRevFile(blocks) {
    return Buffer.concat(blocks.map(txUndos => makeRevRecord(makeBlockUndo(txUndos))));
}

/** Write a Buffer to a temp file and return its path. */
function writeTmp(buf, suffix = '.dat') {
    const p = join(tmpdir(), `revParser_test_${process.pid}_${Date.now()}${suffix}`);
    writeFileSync(p, buf);
    return p;
}

// ---------------------------------------------------------------------------
// Suite 1: readCVarInt
// ---------------------------------------------------------------------------

describe('readCVarInt', () => {
    it('decodes a single zero byte as 0', () => {
        assert.deepStrictEqual(readCVarInt(Buffer.from([0x00]), 0), { value: 0, size: 1 });
    });

    it('decodes single bytes 1–127 as their face value', () => {
        for (const v of [1, 63, 64, 127]) {
            assert.deepStrictEqual(
                readCVarInt(Buffer.from([v]), 0),
                { value: v, size: 1 },
                `failed for value ${v}`
            );
        }
    });

    it('decodes 128 as [0x80, 0x00] (2-byte encoding)', () => {
        assert.deepStrictEqual(
            readCVarInt(Buffer.from([0x80, 0x00]), 0),
            { value: 128, size: 2 }
        );
    });

    it('decodes 255 as [0x80, 0x7F]', () => {
        assert.deepStrictEqual(
            readCVarInt(Buffer.from([0x80, 0x7F]), 0),
            { value: 255, size: 2 }
        );
    });

    it('decodes 256 as [0x81, 0x00]', () => {
        assert.deepStrictEqual(
            readCVarInt(Buffer.from([0x81, 0x00]), 0),
            { value: 256, size: 2 }
        );
    });

    it('round-trips arbitrary values via encodeCVarInt → readCVarInt', () => {
        for (const v of [0, 1, 127, 128, 255, 256, 16383, 16384, 1_000_000, 1_600_000]) {
            const buf = encodeCVarInt(v);
            const { value, size } = readCVarInt(buf, 0);
            assert.strictEqual(value, v, `round-trip failed for value ${v}`);
            assert.strictEqual(size, buf.length, `size mismatch for value ${v}`);
        }
    });

    it('respects the offset parameter', () => {
        const buf = Buffer.concat([Buffer.from([0xFF, 0xFF]), encodeCVarInt(42)]);
        assert.strictEqual(readCVarInt(buf, 2).value, 42);
    });

    it('throws RangeError on buffer underflow', () => {
        assert.throws(
            () => readCVarInt(Buffer.from([0x80]), 0), // continuation byte but no next byte
            RangeError
        );
    });
});

// ---------------------------------------------------------------------------
// Suite 2: decompressAmount
// ---------------------------------------------------------------------------

describe('decompressAmount', () => {
    it('decompresses 0 → 0 sat', () => {
        assert.strictEqual(decompressAmount(0), 0);
    });

    it('decompresses to 5_000_000_000 sat (50 BTC — genesis block reward)', () => {
        // compressAmount(5_000_000_000) = 50
        assert.strictEqual(decompressAmount(50), 5_000_000_000);
    });

    it('decompresses to 100_000_000 sat (1 BTC)', () => {
        // compressAmount(100_000_000) = 9
        assert.strictEqual(decompressAmount(9), 100_000_000);
    });

    it('decompresses to 50_000_000 sat (0.5 BTC)', () => {
        // compressAmount(50_000_000) = 48
        assert.strictEqual(decompressAmount(48), 50_000_000);
    });

    it('decompresses to 99_000_000 sat (0.99 BTC)', () => {
        // compressAmount(99_000_000) = 897
        assert.strictEqual(decompressAmount(897), 99_000_000);
    });

    it('decompresses to 1 sat (minimum non-dust value)', () => {
        // compressAmount(1) = 1+(0*9+1-1)*10+0 = 1
        assert.strictEqual(decompressAmount(1), 1);
    });

    it('round-trips through compressAmount → decompressAmount for common values', () => {
        const amounts = [
            0, 1, 100, 1_000, 10_000, 100_000, 1_000_000,
            5_000_000, 10_000_000, 50_000_000, 100_000_000,
            5_000_000_000, 1_250_000_000,
        ];
        for (const sat of amounts) {
            assert.strictEqual(
                decompressAmount(compressAmount(sat)), sat,
                `round-trip failed for ${sat} sat`
            );
        }
    });
});

// ---------------------------------------------------------------------------
// Suite 3: decompressScript
// ---------------------------------------------------------------------------

describe('decompressScript', () => {
    it('decodes P2PKH (type 0x00) → 76a914...88ac', () => {
        const hash = 'ab'.repeat(20); // 40 hex chars
        const { scriptPubKey, size } = decompressScript(makeP2pkhScript(hash), 0);
        assert.strictEqual(scriptPubKey, `76a914${hash}88ac`);
        assert.strictEqual(size, 21);
    });

    it('decodes P2SH (type 0x01) → a914...87', () => {
        const hash = 'cd'.repeat(20);
        const { scriptPubKey, size } = decompressScript(makeP2shScript(hash), 0);
        assert.strictEqual(scriptPubKey, `a914${hash}87`);
        assert.strictEqual(size, 21);
    });

    it('decodes compressed P2PK with prefix 02 (type 0x02) → 2102...ac', () => {
        const x = 'ab'.repeat(32); // 64 hex chars
        const scriptBuf = makeCompressedPkScript(0x02, x);
        const { scriptPubKey, size } = decompressScript(scriptBuf, 0);
        assert.strictEqual(scriptPubKey, `2102${x}ac`);
        assert.strictEqual(size, 33);
    });

    it('decodes compressed P2PK with prefix 03 (type 0x03) → 2103...ac', () => {
        const x = 'ef'.repeat(32);
        const scriptBuf = makeCompressedPkScript(0x03, x);
        const { scriptPubKey, size } = decompressScript(scriptBuf, 0);
        assert.strictEqual(scriptPubKey, `2103${x}ac`);
        assert.strictEqual(size, 33);
    });

    it('decodes P2WPKH (non-special, 22 bytes) → 0014...', () => {
        const hash = 'aa'.repeat(20);
        const scriptHex = `0014${hash}`;        // P2WPKH script
        const scriptBuf = makeRawScript(scriptHex);
        const { scriptPubKey, size } = decompressScript(scriptBuf, 0);
        assert.strictEqual(scriptPubKey, scriptHex);
        // CVarInt(22+6=28) is 1 byte, then 22 bytes of script
        assert.strictEqual(size, 1 + 22);
    });

    it('decodes P2TR (non-special, 34 bytes) → 5120...', () => {
        const key = 'bb'.repeat(32); // 32-byte tweaked key
        const scriptHex = `5120${key}`;         // P2TR script
        const scriptBuf = makeRawScript(scriptHex);
        const { scriptPubKey, size } = decompressScript(scriptBuf, 0);
        assert.strictEqual(scriptPubKey, scriptHex);
        // CVarInt(34+6=40) is 1 byte, then 34 bytes
        assert.strictEqual(size, 1 + 34);
    });

    it('decodes an empty script (non-special, 0 bytes)', () => {
        const scriptBuf = makeRawScript('');
        const { scriptPubKey, size } = decompressScript(scriptBuf, 0);
        assert.strictEqual(scriptPubKey, '');
        assert.strictEqual(size, 1); // CVarInt(6) = 0x06, 0 bytes follow
    });

    it('decodes a long non-special script requiring multi-byte CVarInt (≥122 bytes)', () => {
        // A 122-byte script → CVarInt(122+6=128) → 2 bytes
        const hex = '51'.repeat(122);
        const buf = makeRawScript(hex);
        const { scriptPubKey, size } = decompressScript(buf, 0);
        assert.strictEqual(scriptPubKey, hex);
        assert.strictEqual(size, 2 + 122); // 2-byte CVarInt + script
    });

    it('correctly advances offset for back-to-back compressed scripts', () => {
        const p2pkh = makeP2pkhScript('aa'.repeat(20));
        const p2sh  = makeP2shScript('bb'.repeat(20));
        const buf   = Buffer.concat([p2pkh, p2sh]);
        const { scriptPubKey: s1, size: sz1 } = decompressScript(buf, 0);
        const { scriptPubKey: s2, size: sz2 } = decompressScript(buf, sz1);
        assert.ok(s1.startsWith('76a914'));
        assert.ok(s2.startsWith('a914'));
        assert.strictEqual(sz1, 21);
        assert.strictEqual(sz2, 21);
    });
});

// ---------------------------------------------------------------------------
// Suite 4: parseRevFile — single block, single tx, P2PKH coin
// ---------------------------------------------------------------------------

describe('parseRevFile — single block, single P2PKH prevout', () => {
    const HASH160 = 'ab'.repeat(20);
    const VALUE   = 100_000_000; // 1 BTC

    const coinBuf = makeCoin({
        height:     700_000,
        is_coinbase: false,
        value_sats: VALUE,
        scriptBuf:  makeP2pkhScript(HASH160),
    });

    // One non-coinbase tx with one input
    const revBuf = makeRevFile([[[coinBuf]]]);

    let revPath;
    let parsed;

    // NB: node:test doesn't support before()/after() in all Node versions at
    //     module level cleanly, so we write the temp file inline in the first
    //     test and reuse the variable in subsequent ones.

    it('parses without throwing', () => {
        revPath = writeTmp(revBuf);
        try {
            parsed = parseRevFile(revPath);
        } finally {
            unlinkSync(revPath);
        }
    });

    it('returns exactly 1 block', () => {
        assert.strictEqual(parsed.blocks.length, 1);
    });

    it('block has txUndos with 1 entry (one non-coinbase tx)', () => {
        assert.strictEqual(parsed.blocks[0].txUndos.length, 1);
    });

    it('that tx has 1 coin (one input)', () => {
        assert.strictEqual(parsed.blocks[0].txUndos[0].length, 1);
    });

    it('coin value_sats is 100_000_000', () => {
        assert.strictEqual(parsed.blocks[0].txUndos[0][0].value_sats, VALUE);
    });

    it('coin script_pubkey is the reconstructed P2PKH hex', () => {
        assert.strictEqual(
            parsed.blocks[0].txUndos[0][0].script_pubkey,
            `76a914${HASH160}88ac`
        );
    });

    it('coin height is 700_000', () => {
        assert.strictEqual(parsed.blocks[0].txUndos[0][0].height, 700_000);
    });

    it('coin is_coinbase is false', () => {
        assert.strictEqual(parsed.blocks[0].txUndos[0][0].is_coinbase, false);
    });
});

// ---------------------------------------------------------------------------
// Suite 5: parseRevFile — coinbase-output flag preserved
// ---------------------------------------------------------------------------

describe('parseRevFile — is_coinbase flag on the coin', () => {
    it('is_coinbase is true when the coin code encodes is_coinbase=1', () => {
        const coinBuf = makeCoin({
            height:     100,
            is_coinbase: true, // spending a coinbase output
            value_sats: 5_000_000_000,
            scriptBuf:  makeP2pkhScript('ff'.repeat(20)),
        });
        const p = writeTmp(makeRevFile([[[coinBuf]]]));
        try {
            const { blocks } = parseRevFile(p);
            assert.strictEqual(blocks[0].txUndos[0][0].is_coinbase, true);
            assert.strictEqual(blocks[0].txUndos[0][0].height, 100);
        } finally {
            unlinkSync(p);
        }
    });
});

// ---------------------------------------------------------------------------
// Suite 6: parseRevFile — P2WPKH prevout
// ---------------------------------------------------------------------------

describe('parseRevFile — P2WPKH prevout', () => {
    const KEY_HASH = 'aa'.repeat(20);
    const VALUE    = 99_000_000;

    it('parses P2WPKH coin and reconstructs the raw script', () => {
        const scriptHex = `0014${KEY_HASH}`;
        const coinBuf = makeCoin({
            height:     800_000,
            is_coinbase: false,
            value_sats: VALUE,
            scriptBuf:  makeRawScript(scriptHex),
        });
        const p = writeTmp(makeRevFile([[[coinBuf]]]));
        try {
            const { blocks } = parseRevFile(p);
            const coin = blocks[0].txUndos[0][0];
            assert.strictEqual(coin.value_sats, VALUE);
            assert.strictEqual(coin.script_pubkey, scriptHex);
        } finally {
            unlinkSync(p);
        }
    });
});

// ---------------------------------------------------------------------------
// Suite 7: parseRevFile — P2TR prevout
// ---------------------------------------------------------------------------

describe('parseRevFile — P2TR prevout', () => {
    it('parses P2TR coin and reconstructs the raw script', () => {
        const key     = 'ef'.repeat(32);
        const scriptHex = `5120${key}`;
        const coinBuf = makeCoin({
            height:     830_000,
            is_coinbase: false,
            value_sats: 50_000,
            scriptBuf:  makeRawScript(scriptHex),
        });
        const p = writeTmp(makeRevFile([[[coinBuf]]]));
        try {
            const coin = parseRevFile(p).blocks[0].txUndos[0][0];
            assert.strictEqual(coin.script_pubkey, scriptHex);
            assert.strictEqual(coin.value_sats, 50_000);
        } finally {
            unlinkSync(p);
        }
    });
});

// ---------------------------------------------------------------------------
// Suite 8: parseRevFile — multi-input transaction
// ---------------------------------------------------------------------------

describe('parseRevFile — transaction with 3 inputs (3 coins)', () => {
    const coins = [
        makeCoin({ height: 600_000, value_sats: 200_000_000, scriptBuf: makeP2pkhScript('aa'.repeat(20)) }),
        makeCoin({ height: 650_000, value_sats: 150_000_000, scriptBuf: makeP2shScript ('bb'.repeat(20)) }),
        makeCoin({ height: 700_000, value_sats:  50_000_000, scriptBuf: makeRawScript(`0014${'cc'.repeat(20)}`) }),
    ];
    let parsed;

    it('parses without throwing', () => {
        const p = writeTmp(makeRevFile([[coins]]));
        try { parsed = parseRevFile(p); } finally { unlinkSync(p); }
    });

    it('returns 3 coins for the single tx', () => {
        assert.strictEqual(parsed.blocks[0].txUndos[0].length, 3);
    });

    it('coin[0] has value 200_000_000 and P2PKH script', () => {
        const c = parsed.blocks[0].txUndos[0][0];
        assert.strictEqual(c.value_sats, 200_000_000);
        assert.match(c.script_pubkey, /^76a914/);
    });

    it('coin[1] has value 150_000_000 and P2SH script', () => {
        const c = parsed.blocks[0].txUndos[0][1];
        assert.strictEqual(c.value_sats, 150_000_000);
        assert.match(c.script_pubkey, /^a914/);
    });

    it('coin[2] has value 50_000_000 and P2WPKH script', () => {
        const c = parsed.blocks[0].txUndos[0][2];
        assert.strictEqual(c.value_sats, 50_000_000);
        assert.match(c.script_pubkey, /^0014/);
    });
});

// ---------------------------------------------------------------------------
// Suite 9: parseRevFile — multi-tx block
// ---------------------------------------------------------------------------

describe('parseRevFile — block with 2 non-coinbase transactions', () => {
    // tx1: 1 input, tx2: 2 inputs
    const tx1Coins = [
        makeCoin({ height: 500_000, value_sats: 1_000_000, scriptBuf: makeP2pkhScript('11'.repeat(20)) }),
    ];
    const tx2Coins = [
        makeCoin({ height: 501_000, value_sats: 2_000_000, scriptBuf: makeP2pkhScript('22'.repeat(20)) }),
        makeCoin({ height: 502_000, value_sats: 3_000_000, scriptBuf: makeP2pkhScript('33'.repeat(20)) }),
    ];
    let parsed;

    it('parses without throwing', () => {
        const p = writeTmp(makeRevFile([[tx1Coins, tx2Coins]]));
        try { parsed = parseRevFile(p); } finally { unlinkSync(p); }
    });

    it('txUndos has 2 entries', () => {
        assert.strictEqual(parsed.blocks[0].txUndos.length, 2);
    });

    it('tx1 has 1 coin', () => {
        assert.strictEqual(parsed.blocks[0].txUndos[0].length, 1);
    });

    it('tx2 has 2 coins', () => {
        assert.strictEqual(parsed.blocks[0].txUndos[1].length, 2);
    });

    it('tx2 coin[0] has value 2_000_000', () => {
        assert.strictEqual(parsed.blocks[0].txUndos[1][0].value_sats, 2_000_000);
    });

    it('tx2 coin[1] has value 3_000_000', () => {
        assert.strictEqual(parsed.blocks[0].txUndos[1][1].value_sats, 3_000_000);
    });
});

// ---------------------------------------------------------------------------
// Suite 10: parseRevFile — multi-block file
// ---------------------------------------------------------------------------

describe('parseRevFile — file with 3 blocks', () => {
    // Three blocks, each with 1 non-coinbase tx and 1 input
    const blocks = [
        [[makeCoin({ height: 100, value_sats: 5_000, scriptBuf: makeP2pkhScript('aa'.repeat(20)) })]],
        [[makeCoin({ height: 200, value_sats: 6_000, scriptBuf: makeP2pkhScript('bb'.repeat(20)) })]],
        [[makeCoin({ height: 300, value_sats: 7_000, scriptBuf: makeP2pkhScript('cc'.repeat(20)) })]],
    ];
    let parsed;

    it('parses without throwing', () => {
        const p = writeTmp(makeRevFile(blocks));
        try { parsed = parseRevFile(p); } finally { unlinkSync(p); }
    });

    it('returns 3 blocks', () => {
        assert.strictEqual(parsed.blocks.length, 3);
    });

    it('block[0] coin value is 5_000', () => {
        assert.strictEqual(parsed.blocks[0].txUndos[0][0].value_sats, 5_000);
    });

    it('block[1] coin value is 6_000', () => {
        assert.strictEqual(parsed.blocks[1].txUndos[0][0].value_sats, 6_000);
    });

    it('block[2] coin value is 7_000', () => {
        assert.strictEqual(parsed.blocks[2].txUndos[0][0].value_sats, 7_000);
    });
});

// ---------------------------------------------------------------------------
// Suite 11: parseRevFile — XOR obfuscation
// ---------------------------------------------------------------------------

describe('parseRevFile — XOR obfuscated file', () => {
    it('parses correctly when the same XOR key is applied before writing', () => {
        const HASH = 'ab'.repeat(20);
        const VALUE = 300_000_000;
        const coinBuf = makeCoin({
            height: 750_000,
            value_sats: VALUE,
            scriptBuf: makeP2pkhScript(HASH),
        });
        const plain = makeRevFile([[[coinBuf]]]);
        const xorKey = Buffer.from([0x12, 0x34, 0x56, 0x78]);

        // Apply XOR to simulate an obfuscated file on disk
        const obfuscated = Buffer.from(plain);
        for (let i = 0; i < obfuscated.length; i++) {
            obfuscated[i] ^= xorKey[i % xorKey.length];
        }

        const p = writeTmp(obfuscated);
        try {
            const { blocks } = parseRevFile(p, xorKey);
            const coin = blocks[0].txUndos[0][0];
            assert.strictEqual(coin.value_sats, VALUE);
            assert.strictEqual(coin.script_pubkey, `76a914${HASH}88ac`);
            assert.strictEqual(coin.height, 750_000);
        } finally {
            unlinkSync(p);
        }
    });
});

// ---------------------------------------------------------------------------
// Suite 12: parseRevFile — error handling
// ---------------------------------------------------------------------------

describe('parseRevFile — error handling', () => {
    it('throws on bad magic number', () => {
        const badMagic = Buffer.alloc(8);
        badMagic.writeUInt32LE(0xDEADBEEF, 0); // wrong magic
        badMagic.writeUInt32LE(32, 4);          // size = 32 (just the checksum)
        const buf = Buffer.concat([badMagic, Buffer.alloc(32)]);
        const p = writeTmp(buf);
        try {
            assert.throws(() => parseRevFile(p), /unexpected magic|0xdeadbeef/i);
        } finally {
            unlinkSync(p);
        }
    });
});

// ---------------------------------------------------------------------------
// Suite 13: resolvePrevouts — basic usage
// ---------------------------------------------------------------------------

describe('resolvePrevouts — basic mapping', () => {
    // A transaction-like object with 2 inputs
    const tx = { vin: [{ prev_txid: 'aa'.repeat(32) }, { prev_txid: 'bb'.repeat(32) }] };

    const txUndoCoins = [
        { value_sats: 100_000_000, script_pubkey: '76a914' + 'aa'.repeat(20) + '88ac', height: 700_000, is_coinbase: false },
        { value_sats:  50_000_000, script_pubkey: '76a914' + 'bb'.repeat(20) + '88ac', height: 700_001, is_coinbase: false },
    ];

    it('returns an array of length 2', () => {
        assert.strictEqual(resolvePrevouts(tx, txUndoCoins).length, 2);
    });

    it('prevout[0].value_sats is 100_000_000', () => {
        assert.strictEqual(resolvePrevouts(tx, txUndoCoins)[0].value_sats, 100_000_000);
    });

    it('prevout[1].value_sats is 50_000_000', () => {
        assert.strictEqual(resolvePrevouts(tx, txUndoCoins)[1].value_sats, 50_000_000);
    });

    it('prevout[0].script_pubkey is the expected P2PKH hex', () => {
        assert.match(resolvePrevouts(tx, txUndoCoins)[0].script_pubkey, /^76a914/);
    });

    it('each prevout has only value_sats and script_pubkey (no height/is_coinbase)', () => {
        for (const p of resolvePrevouts(tx, txUndoCoins)) {
            assert.ok('value_sats'    in p, 'missing value_sats');
            assert.ok('script_pubkey' in p, 'missing script_pubkey');
            assert.strictEqual('height'      in p, false, 'height should not be in prevout');
            assert.strictEqual('is_coinbase' in p, false, 'is_coinbase should not be in prevout');
        }
    });
});

// ---------------------------------------------------------------------------
// Suite 14: resolvePrevouts — fee computation round-trip
// ---------------------------------------------------------------------------

describe('resolvePrevouts — fee computation via parseRevFile round-trip', () => {
    it('total_in - total_out == fee for a synthetic transaction', () => {
        // Build a synthetic undo entry: input spent 2 BTC + 1 BTC = 3 BTC
        const coins = [
            makeCoin({ height: 700_000, value_sats: 200_000_000, scriptBuf: makeP2pkhScript('11'.repeat(20)) }),
            makeCoin({ height: 700_000, value_sats: 100_000_000, scriptBuf: makeP2pkhScript('22'.repeat(20)) }),
        ];
        const p = writeTmp(makeRevFile([[coins]]));
        let prevouts;
        try {
            const { blocks } = parseRevFile(p);
            // Synthetic transaction with 2 inputs
            const syntheticTx = { vin: [{}, {}] };
            prevouts = resolvePrevouts(syntheticTx, blocks[0].txUndos[0]);
        } finally {
            unlinkSync(p);
        }

        const totalIn  = prevouts.reduce((s, p) => s + p.value_sats, 0);
        const totalOut = 295_000_000; // 2.95 BTC in outputs (synthetic)
        const fee      = totalIn - totalOut;

        assert.strictEqual(totalIn,  300_000_000); // 3 BTC in
        assert.strictEqual(fee,        5_000_000); // 0.05 BTC fee
    });
});

// ---------------------------------------------------------------------------
// Suite 15: resolvePrevouts — error handling
// ---------------------------------------------------------------------------

describe('resolvePrevouts — error handling', () => {
    const coins = [{ value_sats: 1_000, script_pubkey: '76a914' + 'aa'.repeat(20) + '88ac' }];

    it('throws TypeError when transaction has no vin', () => {
        assert.throws(() => resolvePrevouts({}, coins), TypeError);
    });

    it('throws TypeError when txUndoCoins is not an array', () => {
        assert.throws(() => resolvePrevouts({ vin: [{}] }, null), TypeError);
    });

    it('throws Error on input count mismatch (too many coins)', () => {
        const tx = { vin: [{}] };
        const extraCoins = [...coins, ...coins]; // 2 coins, 1 input
        assert.throws(
            () => resolvePrevouts(tx, extraCoins),
            /input count mismatch|mismatch/i
        );
    });

    it('throws Error on input count mismatch (too few coins)', () => {
        const tx = { vin: [{}, {}] }; // 2 inputs, 1 coin
        assert.throws(
            () => resolvePrevouts(tx, coins),
            /input count mismatch|mismatch/i
        );
    });
});
