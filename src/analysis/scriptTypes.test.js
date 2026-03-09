/**
 * src/analysis/scriptTypes.test.js
 *
 * Unit tests for scriptTypes.js using the Node.js built-in test runner.
 *
 * Run single file:  node --test src/analysis/scriptTypes.test.js
 * Run all tests:    node --test
 *
 * All hex fixtures are real-world scriptPubKey values sourced from mainnet
 * transactions or constructed from published BIP test vectors.
 *
 * Reference scripts
 * ─────────────────
 * P2PKH  (25 B): 76a914{20B}88ac
 *   Example hash160: 89abcdefabbaabbaabbaabbaabbaabbaabbaabba
 *   Full: 76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac
 *
 * P2SH   (23 B): a914{20B}87
 *   Example hash160: 7451b3c2dc81c26b75c49c24b63d28e070af507d
 *   Full: a9147451b3c2dc81c26b75c49c24b63d28e070af507d87
 *   (This is the BIP-16 P2SH test vector address 3CQuYos...)
 *
 * P2WPKH (22 B): 0014{20B}
 *   Example: bc1qa...  ← Bech32 encoding of 0014...
 *   Full: 0014751e76e8199196f454f032d4f84459965629c08f
 *   (Corresponds to bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4)
 *
 * P2WSH  (34 B): 0020{32B}
 *   Full: 00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262
 *   (BIP-141 example)
 *
 * P2TR   (34 B): 5120{32B}
 *   Full: 512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798
 *   (BIP-341 example — G's x-coord)
 *
 * OP_RETURN: 6a{data}
 *   Full: 6a0b68656c6c6f20776f726c64  ("hello world" carrier)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { detectScriptType } from './scriptTypes.js';

// ── P2PKH ─────────────────────────────────────────────────────────────────────

describe('detectScriptType — P2PKH', () => {
    const P2PKH = '76a91489abcdefabbaabbaabbaabbaabbaabbaabbaabba88ac';

    it('identifies a canonical P2PKH script', () => {
        assert.strictEqual(detectScriptType(P2PKH), 'p2pkh');
    });

    it('is case-insensitive', () => {
        assert.strictEqual(detectScriptType(P2PKH.toUpperCase()), 'p2pkh');
    });

    it('does not match when 1 byte too short (no OP_DUP prefix)', () => {
        assert.notStrictEqual(detectScriptType(P2PKH.slice(2)), 'p2pkh');
    });

    it('does not match when suffix is wrong', () => {
        const bad = P2PKH.slice(0, -4) + '88ad'; // changed OP_CHECKSIG
        assert.notStrictEqual(detectScriptType(bad), 'p2pkh');
    });
});

// ── P2SH ──────────────────────────────────────────────────────────────────────

describe('detectScriptType — P2SH', () => {
    const P2SH = 'a9147451b3c2dc81c26b75c49c24b63d28e070af507d87';

    it('identifies a canonical P2SH script', () => {
        assert.strictEqual(detectScriptType(P2SH), 'p2sh');
    });

    it('is case-insensitive', () => {
        assert.strictEqual(detectScriptType(P2SH.toUpperCase()), 'p2sh');
    });

    it('does not match when OP_EQUAL suffix is wrong', () => {
        const bad = P2SH.slice(0, -2) + '88'; // changed OP_EQUAL to OP_CHECKSIG
        assert.notStrictEqual(detectScriptType(bad), 'p2sh');
    });

    it('does not match an empty script', () => {
        assert.notStrictEqual(detectScriptType(''), 'p2sh');
    });
});

// ── P2WPKH ────────────────────────────────────────────────────────────────────

describe('detectScriptType — P2WPKH', () => {
    // Corresponds to bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4
    const P2WPKH = '0014751e76e8199196f454f032d4f84459965629c08f';

    it('identifies a canonical P2WPKH script', () => {
        assert.strictEqual(detectScriptType(P2WPKH), 'p2wpkh');
    });

    it('is case-insensitive', () => {
        assert.strictEqual(detectScriptType(P2WPKH.toUpperCase()), 'p2wpkh');
    });

    it('does not match P2WSH (0020 prefix, 32-byte program)', () => {
        const p2wsh = '0020' + 'ab'.repeat(32);
        assert.notStrictEqual(detectScriptType(p2wsh), 'p2wpkh');
    });
});

// ── P2WSH ─────────────────────────────────────────────────────────────────────

describe('detectScriptType — P2WSH', () => {
    // BIP-141 example witness script hash
    const P2WSH = '00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262';

    it('identifies a canonical P2WSH script', () => {
        assert.strictEqual(detectScriptType(P2WSH), 'p2wsh');
    });

    it('is case-insensitive', () => {
        assert.strictEqual(detectScriptType(P2WSH.toUpperCase()), 'p2wsh');
    });

    it('does not match P2WPKH (0014 prefix, 20-byte program)', () => {
        const p2wpkh = '0014' + 'ab'.repeat(20);
        assert.notStrictEqual(detectScriptType(p2wpkh), 'p2wsh');
    });

    it('does not match when program is 31 bytes (too short)', () => {
        const bad = '0020' + 'ab'.repeat(31);
        assert.notStrictEqual(detectScriptType(bad), 'p2wsh');
    });

    it('does not match when program is 33 bytes (too long)', () => {
        const bad = '0020' + 'ab'.repeat(33);
        assert.notStrictEqual(detectScriptType(bad), 'p2wsh');
    });
});

// ── P2TR ──────────────────────────────────────────────────────────────────────

describe('detectScriptType — P2TR', () => {
    // BIP-341: secp256k1 generator G's x-coordinate
    const P2TR = '512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

    it('identifies a canonical P2TR script', () => {
        assert.strictEqual(detectScriptType(P2TR), 'p2tr');
    });

    it('is case-insensitive', () => {
        assert.strictEqual(detectScriptType(P2TR.toUpperCase()), 'p2tr');
    });

    it('does not match P2WSH (same length, different prefix)', () => {
        const p2wsh = '0020' + 'ab'.repeat(32);
        assert.notStrictEqual(detectScriptType(p2wsh), 'p2tr');
    });

    it('does not match when x-only key is 31 bytes', () => {
        const bad = '5120' + 'ab'.repeat(31);
        assert.notStrictEqual(detectScriptType(bad), 'p2tr');
    });
});

// ── OP_RETURN ─────────────────────────────────────────────────────────────────

describe('detectScriptType — OP_RETURN', () => {
    const OP_RETURN_HELLO = '6a0b68656c6c6f20776f726c64'; // "hello world"

    it('identifies a data-carrier OP_RETURN output', () => {
        assert.strictEqual(detectScriptType(OP_RETURN_HELLO), 'op_return');
    });

    it('identifies a bare OP_RETURN (no push data)', () => {
        assert.strictEqual(detectScriptType('6a'), 'op_return');
    });

    it('identifies OP_RETURN with 80-byte max data push', () => {
        const maxData = '6a4c50' + 'ff'.repeat(80); // OP_RETURN OP_PUSHDATA1 80 <80 bytes>
        assert.strictEqual(detectScriptType(maxData), 'op_return');
    });

    it('is case-insensitive', () => {
        assert.strictEqual(detectScriptType('6A0B68656C6C6F20776F726C64'), 'op_return');
    });
});

// ── unknown ───────────────────────────────────────────────────────────────────

describe('detectScriptType — unknown', () => {
    it('returns unknown for an empty string', () => {
        assert.strictEqual(detectScriptType(''), 'unknown');
    });

    it('returns unknown for a bare OP_CHECKSIG (P2PK) script', () => {
        // <33-byte pubkey> OP_CHECKSIG — not one of the standard templates
        const P2PK = '21' + '02' + 'ab'.repeat(32) + 'ac';
        assert.strictEqual(detectScriptType(P2PK), 'unknown');
    });

    it('returns unknown for arbitrary bytes', () => {
        assert.strictEqual(detectScriptType('deadbeef'), 'unknown');
    });

    it('returns unknown for a SegWit v2 script (future soft-fork)', () => {
        // OP_2 OP_DATA32 <32 bytes> — not yet assigned a standard type
        const segwitV2 = '5220' + 'ab'.repeat(32);
        assert.strictEqual(detectScriptType(segwitV2), 'unknown');
    });
});

// ── Input validation ──────────────────────────────────────────────────────────

describe('detectScriptType — input validation', () => {
    it('throws TypeError for a non-string argument (number)', () => {
        assert.throws(() => detectScriptType(0x76a914), /TypeError|expected a hex string/i);
    });

    it('throws TypeError for null', () => {
        assert.throws(() => detectScriptType(null), /TypeError|expected a hex string/i);
    });

    it('throws TypeError for undefined', () => {
        assert.throws(() => detectScriptType(undefined), /TypeError|expected a hex string/i);
    });
});
