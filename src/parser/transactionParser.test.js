/**
 * src/parser/transactionParser.test.js
 *
 * Unit tests for transactionParser.js using the Node.js built-in test runner.
 *
 * Run single file:  node --test src/parser/transactionParser.test.js
 * Run all tests:    node --test
 *
 * All three fixture transactions were built from first principles and their
 * txids verified by independently computing double-SHA256 outside of the
 * module under test.
 *
 * GENESIS_COINBASE  — Bitcoin block 0 coinbase (50 BTC, Satoshi's key)
 *   txid: 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b
 *
 * LEGACY_P2PKH  — Synthetic v2 tx: 1 input spending genesis, 2 P2PKH outputs
 *   txid: f18925bf128d37b5a1a15eb734598a5bc67e240134d2c1e0527cd678f8523473
 *   vout[0]: 100_000_000 sat  vout[1]: 50_000_000 sat
 *
 * SEGWIT_P2WPKH  — Synthetic v1 SegWit tx: 1 P2WPKH input, 1 P2WPKH output
 *   txid (non-witness): fab2703f68a222f7ee1bcf67667fe7f7a6f4d44150e287870d0c84715926c9e3
 *   empty scriptSig; witness: 71-byte sig + 33-byte pubkey
 */

import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeTransaction } from './transactionParser.js';

// ---------------------------------------------------------------------------
// Verified single-line raw-hex fixtures — do NOT split these strings
// ---------------------------------------------------------------------------

const GENESIS_COINBASE_HEX = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000';

const LEGACY_P2PKH_HEX = '02000000013ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a000000005b47304402abcdef01234567890a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b0220abcdef01234567890a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b01ffffffff0200e1f505000000001976a914abababababababababababababababababababab88ac80f0fa02000000001976a914cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd88ac00000000';

const SEGWIT_P2WPKH_HEX = '010000000001013ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a0000000000fdffffff01c09ee60500000000160014aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa024731313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131313131312102abababababababababababababababababababababababababababababababab00000000';

// ---------------------------------------------------------------------------
// Suite 1: Genesis coinbase (block 0)
// ---------------------------------------------------------------------------

describe('decodeTransaction — genesis coinbase (block 0)', () => {
  const rawTx = Buffer.from(GENESIS_COINBASE_HEX, 'hex');

  it('decodes without throwing', () => {
    decodeTransaction(rawTx);
  });

  it('txid matches the canonical genesis coinbase txid', () => {
    assert.strictEqual(
      decodeTransaction(rawTx).txid,
      '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
    );
  });

  it('version is 1', () => {
    assert.strictEqual(decodeTransaction(rawTx).version, 1);
  });

  it('segwit is false', () => {
    assert.strictEqual(decodeTransaction(rawTx).segwit, false);
  });

  it('has exactly 1 input', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin.length, 1);
  });

  it('input prev_txid is the null hash (coinbase)', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin[0].prev_txid, '0'.repeat(64));
  });

  it('input vout is 0xffffffff (coinbase marker)', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin[0].vout, 0xffffffff);
  });

  it('input sequence is 0xffffffff', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin[0].sequence, 0xffffffff);
  });

  it('scriptSig is a non-empty hex string', () => {
    const { scriptSig } = decodeTransaction(rawTx).vin[0];
    assert.match(scriptSig, /^[0-9a-f]+$/);
    assert.ok(scriptSig.length > 0);
  });

  it('has exactly 1 output', () => {
    assert.strictEqual(decodeTransaction(rawTx).vout.length, 1);
  });

  it('output value is 50 BTC (5_000_000_000 satoshis)', () => {
    assert.strictEqual(decodeTransaction(rawTx).vout[0].value_sats, 5_000_000_000);
  });

  it('scriptPubKey is a non-empty hex string', () => {
    const { scriptPubKey } = decodeTransaction(rawTx).vout[0];
    assert.match(scriptPubKey, /^[0-9a-f]+$/);
    assert.ok(scriptPubKey.length > 0);
  });

  it('locktime is 0', () => {
    assert.strictEqual(decodeTransaction(rawTx).locktime, 0);
  });

  it('size equals rawTx.length (204 bytes)', () => {
    assert.strictEqual(decodeTransaction(rawTx).size, rawTx.length);
    assert.strictEqual(decodeTransaction(rawTx).size, 204);
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Legacy P2PKH transaction (2 outputs)
// ---------------------------------------------------------------------------

describe('decodeTransaction — legacy P2PKH tx (2 outputs)', () => {
  const rawTx = Buffer.from(LEGACY_P2PKH_HEX, 'hex');

  it('decodes without throwing', () => {
    decodeTransaction(rawTx);
  });

  it('txid is the verified synthetic txid', () => {
    assert.strictEqual(
      decodeTransaction(rawTx).txid,
      'f18925bf128d37b5a1a15eb734598a5bc67e240134d2c1e0527cd678f8523473'
    );
  });

  it('version is 2', () => {
    assert.strictEqual(decodeTransaction(rawTx).version, 2);
  });

  it('segwit is false', () => {
    assert.strictEqual(decodeTransaction(rawTx).segwit, false);
  });

  it('has exactly 1 input', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin.length, 1);
  });

  it('input prev_txid is the genesis coinbase txid', () => {
    assert.strictEqual(
      decodeTransaction(rawTx).vin[0].prev_txid,
      '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
    );
  });

  it('input vout is 0', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin[0].vout, 0);
  });

  it('input sequence is 0xffffffff', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin[0].sequence, 0xffffffff);
  });

  it('has exactly 2 outputs', () => {
    assert.strictEqual(decodeTransaction(rawTx).vout.length, 2);
  });

  it('vout[0] value is 1 BTC (100_000_000 satoshis)', () => {
    assert.strictEqual(decodeTransaction(rawTx).vout[0].value_sats, 100_000_000);
  });

  it('vout[1] value is 0.5 BTC (50_000_000 satoshis)', () => {
    assert.strictEqual(decodeTransaction(rawTx).vout[1].value_sats, 50_000_000);
  });

  it('vout[0] scriptPubKey starts with P2PKH prefix (76a914)', () => {
    assert.ok(decodeTransaction(rawTx).vout[0].scriptPubKey.startsWith('76a914'));
  });

  it('vout[1] scriptPubKey starts with P2PKH prefix (76a914)', () => {
    assert.ok(decodeTransaction(rawTx).vout[1].scriptPubKey.startsWith('76a914'));
  });

  it('locktime is 0', () => {
    assert.strictEqual(decodeTransaction(rawTx).locktime, 0);
  });

  it('size equals rawTx.length (210 bytes)', () => {
    assert.strictEqual(decodeTransaction(rawTx).size, rawTx.length);
    assert.strictEqual(decodeTransaction(rawTx).size, 210);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: SegWit P2WPKH transaction
// ---------------------------------------------------------------------------

describe('decodeTransaction — SegWit P2WPKH tx', () => {
  const rawTx = Buffer.from(SEGWIT_P2WPKH_HEX, 'hex');

  it('decodes without throwing', () => {
    decodeTransaction(rawTx);
  });

  it('txid equals the BIP-141 non-witness hash', () => {
    assert.strictEqual(
      decodeTransaction(rawTx).txid,
      'fab2703f68a222f7ee1bcf67667fe7f7a6f4d44150e287870d0c84715926c9e3'
    );
  });

  it('txid differs from the hash-of-full-bytes (witness stripped)', () => {
    const fullHash = Buffer.from(
      createHash('sha256').update(createHash('sha256').update(rawTx).digest()).digest()
    ).reverse().toString('hex');
    assert.notStrictEqual(decodeTransaction(rawTx).txid, fullHash);
  });

  it('segwit is true', () => {
    assert.strictEqual(decodeTransaction(rawTx).segwit, true);
  });

  it('version is 1', () => {
    assert.strictEqual(decodeTransaction(rawTx).version, 1);
  });

  it('has 1 input', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin.length, 1);
  });

  it('input scriptSig is empty (native SegWit)', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin[0].scriptSig, '');
  });

  it('input sequence is 0xfffffffd (RBF)', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin[0].sequence, 0xfffffffd);
  });

  it('has 1 output', () => {
    assert.strictEqual(decodeTransaction(rawTx).vout.length, 1);
  });

  it('output value is 99_000_000 sat (~0.99 BTC)', () => {
    assert.strictEqual(decodeTransaction(rawTx).vout[0].value_sats, 99_000_000);
  });

  it('output scriptPubKey starts with P2WPKH prefix (0014)', () => {
    assert.ok(decodeTransaction(rawTx).vout[0].scriptPubKey.startsWith('0014'));
  });

  it('witness array is present on vin[0] and has 2 items', () => {
    const { vin } = decodeTransaction(rawTx);
    assert.ok(Array.isArray(vin[0].witness));
    assert.strictEqual(vin[0].witness.length, 2);
  });

  it('witness item[0] is 71 bytes (142 hex chars) — DER signature', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin[0].witness[0].length, 142);
  });

  it('witness item[1] is 33 bytes (66 hex chars) — compressed pubkey', () => {
    assert.strictEqual(decodeTransaction(rawTx).vin[0].witness[1].length, 66);
  });

  it('locktime is 0', () => {
    assert.strictEqual(decodeTransaction(rawTx).locktime, 0);
  });

  it('size equals rawTx.length (191 bytes)', () => {
    assert.strictEqual(decodeTransaction(rawTx).size, rawTx.length);
    assert.strictEqual(decodeTransaction(rawTx).size, 191);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Return shape
// ---------------------------------------------------------------------------

describe('decodeTransaction — return shape', () => {
  it('all required top-level fields are present', () => {
    const keys = ['txid', 'version', 'vin', 'vout', 'locktime', 'size', 'segwit'];
    const decoded = decodeTransaction(Buffer.from(GENESIS_COINBASE_HEX, 'hex'));
    for (const key of keys) {
      assert.ok(Object.prototype.hasOwnProperty.call(decoded, key), `missing field: ${key}`);
    }
  });

  it('each vin entry has prev_txid, vout, scriptSig, sequence', () => {
    const decoded = decodeTransaction(Buffer.from(LEGACY_P2PKH_HEX, 'hex'));
    for (const input of decoded.vin) {
      assert.ok('prev_txid' in input, 'vin missing prev_txid');
      assert.ok('vout'      in input, 'vin missing vout');
      assert.ok('scriptSig' in input, 'vin missing scriptSig');
      assert.ok('sequence'  in input, 'vin missing sequence');
    }
  });

  it('each vout entry has value_sats and scriptPubKey', () => {
    const decoded = decodeTransaction(Buffer.from(LEGACY_P2PKH_HEX, 'hex'));
    for (const output of decoded.vout) {
      assert.ok('value_sats'   in output, 'vout missing value_sats');
      assert.ok('scriptPubKey' in output, 'vout missing scriptPubKey');
    }
  });

  it('txid is a 64-char lowercase hex string', () => {
    const { txid } = decodeTransaction(Buffer.from(GENESIS_COINBASE_HEX, 'hex'));
    assert.match(txid, /^[0-9a-f]{64}$/);
  });

  it('scriptSig and scriptPubKey are lowercase hex strings (or empty)', () => {
    const decoded = decodeTransaction(Buffer.from(GENESIS_COINBASE_HEX, 'hex'));
    assert.match(decoded.vin[0].scriptSig,     /^[0-9a-f]*$/);
    assert.match(decoded.vout[0].scriptPubKey, /^[0-9a-f]+$/);
  });

  it('vin[0].witness is undefined on legacy transactions', () => {
    const decoded = decodeTransaction(Buffer.from(GENESIS_COINBASE_HEX, 'hex'));
    assert.strictEqual(decoded.vin[0].witness, undefined);
  });

  it('vin[0].witness is an Array on SegWit transactions', () => {
    const decoded = decodeTransaction(Buffer.from(SEGWIT_P2WPKH_HEX, 'hex'));
    assert.ok(Array.isArray(decoded.vin[0].witness));
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Error handling
// ---------------------------------------------------------------------------

describe('decodeTransaction — error handling', () => {
  it('throws for a non-Buffer argument', () => {
    assert.throws(() => decodeTransaction('not a buffer'), /expected a buffer/i);
  });

  it('throws for a buffer that is too short (< 10 bytes)', () => {
    assert.throws(() => decodeTransaction(Buffer.alloc(5)), /expected a buffer/i);
  });

  it('throws for trailing bytes after the transaction', () => {
    const rawTx = Buffer.from(GENESIS_COINBASE_HEX, 'hex');
    const padded = Buffer.concat([rawTx, Buffer.from([0x00, 0x00])]);
    assert.throws(() => decodeTransaction(padded), /trailing bytes/i);
  });
});
