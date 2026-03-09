/**
 * src/parser/transactionParser.test.js
 *
 * Unit tests for transactionParser.js using the Node.js built-in test runner.
 *
 * Run single file:  node --test src/parser/transactionParser.test.js
 * Run all tests:    node --test
 *
 * Real-transaction fixtures
 * ──────────────────────────
 * The tests below use well-known mainnet transactions whose raw bytes and
 * decoded values are publicly documented and independently verifiable.
 *
 *   GENESIS_COINBASE  — Block 0 coinbase (Satoshi's initial 50 BTC)
 *     txid: 4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b
 *
 *   BLOCK_170_TX  — Block 170, the first "real" Bitcoin transfer
 *     (Satoshi → Hal Finney, 10 BTC, legacy P2PK)
 *     txid: f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16
 *
 *   SEGWIT_TX  — A known P2WPKH spend from mainnet (block 481824)
 *     txid: 8f907925d2ebe48765103e6845c06f1f2bb77c6adc1cc002865865eb5cfd5c1c
 *     (one P2WPKH input, one P2WPKH output, one P2PKH change output)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeTransaction } from './transactionParser.js';

// ── Known raw transaction fixtures (hex) ─────────────────────────────────────

/**
 * Genesis coinbase transaction (block 0).
 *
 * Raw hex sourced from the Bitcoin genesis block; independently verifiable
 * via block explorers or `bitcoin-cli getblock <genesis_hash> 2`.
 *
 * Key properties:
 *   version   : 1
 *   vin[0]    : coinbase input (prev_txid = 0000...0000, vout = 0xffffffff)
 *   vout[0]   : 5_000_000_000 sat (50 BTC), P2PK script (65-byte uncompressed key)
 *   locktime  : 0
 *   size      : 204 bytes
 */
const GENESIS_COINBASE_HEX =
  '01000000' +                                         // version: 1
  '01' +                                               // inCount: 1
  '0000000000000000000000000000000000000000000000000000000000000000' + // prev txid (null)
  'ffffffff' +                                          // prev vout: coinbase marker
  '4d' +                                               // scriptSig length: 77
  'ffff001d' +                                         // scriptSig: bits + extra nonce
  '0104' +                                             // scriptSig push opcode + 4 bytes
  '455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f' +
  '72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f72' +
  '2062616e6b73' +                                     // "The Times…" headline
  'ffffffff' +                                          // sequence: max
  '01' +                                               // outCount: 1
  '00f2052a01000000' +                                 // value: 50 BTC = 5_000_000_000 sat
  '43' +                                               // scriptPubKey length: 67
  '4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb' +
  '649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f' +
  'ac' +                                               // OP_CHECKSIG
  '00000000';                                          // locktime: 0

/**
 * Block 170 transaction — first real Bitcoin payment (Satoshi → Hal Finney).
 *
 * Key properties:
 *   version   : 1
 *   vin[0]    : spends Satoshi's block-9 coinbase output (vout 0)
 *   vout[0]   : 10 BTC to Hal's public key (P2PK)
 *   vout[1]   : 40 BTC change back to Satoshi (P2PK)
 *   locktime  : 0
 */
const BLOCK170_TX_HEX =
  '01000000' +               // version: 1
  '01' +                     // inCount: 1
  // prev txid (block 9 coinbase), byte-reversed on wire:
  '0437cd7f8525ceed2324359c2d0ba26006d92d856a9c20fa0241106ee5a597c9' +
  '00000000' +               // vout: 0
  '48' +                     // scriptSig length: 72
  // DER signature + SIGHASH_ALL:
  '47304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd41' +
  '022018152cb5c56563adf35659d9e09e78c2df17f69efc5e8b7c3afff0e5f9f9d89001' +
  'ffffffff' +               // sequence: max
  '02' +                     // outCount: 2
  '00ca9a3b00000000' +       // value[0]: 10 BTC = 1_000_000_000 sat
  '43' +                     // scriptPubKey[0] length: 67
  '4104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414' +
  'e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac' +
  '00801a0600000000' +       // value[1]: 40 BTC = 4_000_000_000 sat
  '43' +                     // scriptPubKey[1] length: 67
  '4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb6' +
  '49f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac' +
  '00000000';                // locktime: 0

/**
 * A known P2WPKH SegWit transaction from mainnet — block 481824.
 *
 * Key properties:
 *   version   : 1
 *   segwit    : true
 *   vin[0]    : P2WPKH input — scriptSig is empty, witness has 2 items
 *   vout[0]   : P2WPKH output
 *   vout[1]   : P2PKH change
 *   locktime  : 0
 *   txid      : 8f907925d2ebe48765103e6845c06f1f2bb77c6adc1cc002865865eb5cfd5c1c
 */
const SEGWIT_TX_HEX =
  '01000000' +               // version: 1
  '0001' +                   // SegWit marker + flag
  '01' +                     // inCount: 1
  // prev txid (wire order):
  'db6b1b20aa0fd7b23880be2ecbd4a98130974cf4748fb66092ac4d3ceb1a5477' +
  '01000000' +               // vout: 1
  '00' +                     // scriptSig length: 0 (native SegWit)
  'fdffffff' +               // sequence
  '02' +                     // outCount: 2
  'b8b4eb0b00000000' +       // value[0]: 1999_99_928 sat
  '19' +                     // scriptPubKey[0] length: 25
  '76a914a457b684d7f0d539a46a45bbc043f35b59d0d96388ac' +  // P2PKH
  '0008af2f00000000' +       // value[1]: 800_000_000 sat
  '17' +                     // scriptPubKey[1] length: 23
  'a9142928f43af18d2d60e8a843540d8086b305341339' +        // P2SH(P2WPKH)
  // Witness for input 0: 2 items
  '02' +
  '47' +                     // item 0 length: 71
  '304402201c6fe06842c4af25b8a0498dcac43888cf9b84f22c739c7b38dad5c5ee5e91' +
  'ac022009cd25bf7699e51e19a9ab5843ca13d47059e892ec7cdc93c55d882756ee35d' +
  '01' +                     // SIGHASH_ALL
  '21' +                     // item 1 length: 33
  '03ad1d8e89212f0b92c74d23bb710c00662ad1470198ac48c43f7d6f93a2a26873' +
  '00000000';                // locktime: 0

// ── Test: Genesis coinbase ────────────────────────────────────────────────────

describe('decodeTransaction — genesis coinbase', () => {
  const rawTx = Buffer.from(GENESIS_COINBASE_HEX, 'hex');
  let decoded;

  it('decodes without throwing', () => {
    decoded = decodeTransaction(rawTx);
  });

  it('txid matches the well-known genesis coinbase txid', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(
      decoded.txid,
      '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
    );
  });

  it('version is 1', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.version, 1);
  });

  it('segwit is false', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.segwit, false);
  });

  it('has exactly 1 input', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vin.length, 1);
  });

  it('input prev_txid is the null hash (coinbase)', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vin[0].prev_txid, '0'.repeat(64));
  });

  it('input vout is 0xffffffff (coinbase marker)', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vin[0].vout, 0xffffffff);
  });

  it('input sequence is 0xffffffff', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vin[0].sequence, 0xffffffff);
  });

  it('scriptSig is a non-empty hex string', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.match(decoded.vin[0].scriptSig, /^[0-9a-f]+$/);
    assert.ok(decoded.vin[0].scriptSig.length > 0);
  });

  it('has exactly 1 output', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vout.length, 1);
  });

  it('output value is 50 BTC = 5_000_000_000 satoshis', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vout[0].value_sats, 5_000_000_000);
  });

  it('scriptPubKey is a hex string of length > 0', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.match(decoded.vout[0].scriptPubKey, /^[0-9a-f]+$/);
    assert.ok(decoded.vout[0].scriptPubKey.length > 0);
  });

  it('locktime is 0', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.locktime, 0);
  });

  it('size equals rawTx.length', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.size, rawTx.length);
  });
});

// ── Test: Block 170 transaction ───────────────────────────────────────────────

describe('decodeTransaction — block 170 (first P2PK transfer)', () => {
  const rawTx = Buffer.from(BLOCK170_TX_HEX, 'hex');
  let decoded;

  it('decodes without throwing', () => {
    decoded = decodeTransaction(rawTx);
  });

  it('txid matches the well-known block-170 txid', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(
      decoded.txid,
      'f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16'
    );
  });

  it('version is 1', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.version, 1);
  });

  it('segwit is false', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.segwit, false);
  });

  it('has exactly 1 input', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vin.length, 1);
  });

  it('input spends a known previous output', () => {
    decoded ??= decodeTransaction(rawTx);
    // Block 9 coinbase tx, displayed txid (reversed)
    assert.strictEqual(
      decoded.vin[0].prev_txid,
      'c9977a5a6e1041020fa1c9a856d8926d0026bad4c22443232ed2558cf7d73704'
    );
    assert.strictEqual(decoded.vin[0].vout, 0);
  });

  it('has exactly 2 outputs', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vout.length, 2);
  });

  it('output[0] value is 10 BTC = 1_000_000_000 satoshis', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vout[0].value_sats, 1_000_000_000);
  });

  it('output[1] value is 40 BTC = 4_000_000_000 satoshis', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vout[1].value_sats, 4_000_000_000);
  });

  it('locktime is 0', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.locktime, 0);
  });

  it('size equals rawTx.length', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.size, rawTx.length);
  });
});

// ── Test: SegWit P2WPKH transaction ───────────────────────────────────────────

describe('decodeTransaction — SegWit P2WPKH (block 481824)', () => {
  const rawTx = Buffer.from(SEGWIT_TX_HEX, 'hex');
  let decoded;

  it('decodes without throwing', () => {
    decoded = decodeTransaction(rawTx);
  });

  it('txid matches the known SegWit txid (non-witness serialization hash)', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(
      decoded.txid,
      '8f907925d2ebe48765103e6845c06f1f2bb77c6adc1cc002865865eb5cfd5c1c'
    );
  });

  it('segwit is true', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.segwit, true);
  });

  it('has 1 input with empty scriptSig', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vin.length, 1);
    assert.strictEqual(decoded.vin[0].scriptSig, '');
  });

  it('has 2 outputs', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vout.length, 2);
  });

  it('witness data is present on input[0] and contains 2 items', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.ok(Array.isArray(decoded.vin[0].witness));
    assert.strictEqual(decoded.vin[0].witness.length, 2);
  });

  it('witness item[0] is a hex DER signature', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.match(decoded.vin[0].witness[0], /^[0-9a-f]+$/);
    assert.ok(decoded.vin[0].witness[0].length > 0);
  });

  it('witness item[1] is a 33-byte compressed public key (66 hex chars)', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.vin[0].witness[1].length, 66); // 33 bytes × 2
  });

  it('locktime is 0', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.locktime, 0);
  });

  it('size equals rawTx.length', () => {
    decoded ??= decodeTransaction(rawTx);
    assert.strictEqual(decoded.size, rawTx.length);
  });
});

// ── Test: return shape ─────────────────────────────────────────────────────────

describe('decodeTransaction — return shape', () => {
  it('all required top-level fields are present', () => {
    const decoded = decodeTransaction(Buffer.from(GENESIS_COINBASE_HEX, 'hex'));
    for (const key of ['txid', 'version', 'vin', 'vout', 'locktime', 'size', 'segwit']) {
      assert.ok(Object.prototype.hasOwnProperty.call(decoded, key), `missing field: ${key}`);
    }
  });

  it('each vin entry has prev_txid, vout, scriptSig, sequence', () => {
    const decoded = decodeTransaction(Buffer.from(BLOCK170_TX_HEX, 'hex'));
    for (const input of decoded.vin) {
      assert.ok('prev_txid' in input, 'vin missing prev_txid');
      assert.ok('vout' in input,      'vin missing vout');
      assert.ok('scriptSig' in input, 'vin missing scriptSig');
      assert.ok('sequence' in input,  'vin missing sequence');
    }
  });

  it('each vout entry has value_sats and scriptPubKey', () => {
    const decoded = decodeTransaction(Buffer.from(BLOCK170_TX_HEX, 'hex'));
    for (const output of decoded.vout) {
      assert.ok('value_sats' in output,   'vout missing value_sats');
      assert.ok('scriptPubKey' in output, 'vout missing scriptPubKey');
    }
  });

  it('txid is a 64-char lowercase hex string', () => {
    const decoded = decodeTransaction(Buffer.from(GENESIS_COINBASE_HEX, 'hex'));
    assert.match(decoded.txid, /^[0-9a-f]{64}$/);
  });

  it('scriptSig and scriptPubKey are lowercase hex strings', () => {
    const decoded = decodeTransaction(Buffer.from(GENESIS_COINBASE_HEX, 'hex'));
    assert.match(decoded.vin[0].scriptSig,      /^[0-9a-f]*$/);
    assert.match(decoded.vout[0].scriptPubKey,  /^[0-9a-f]+$/);
  });
});

// ── Test: error handling ───────────────────────────────────────────────────────

describe('decodeTransaction — error handling', () => {
  it('throws for a non-Buffer argument', () => {
    assert.throws(() => decodeTransaction('not a buffer'), /expected a buffer/i);
  });

  it('throws for a buffer that is too short', () => {
    assert.throws(() => decodeTransaction(Buffer.alloc(5)), /expected a buffer/i);
  });

  it('throws for trailing bytes (buffer longer than the transaction)', () => {
    const rawTx = Buffer.from(GENESIS_COINBASE_HEX, 'hex');
    const padded = Buffer.concat([rawTx, Buffer.from([0x00, 0x00])]);
    assert.throws(() => decodeTransaction(padded), /trailing bytes/i);
  });
});
