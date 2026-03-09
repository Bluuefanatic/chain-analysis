/**
 * src/parser/transactionParser.test.js
 *
 * Unit tests for transactionParser.js using the Node.js built-in test runner.
 *
 * Run single file:  node --test src/parser/transactionParser.test.js
 * Run all tests:    node --test
 *
 * All fixture transactions are built from first principles with txids
 * verified by independently computing double-SHA256 outside of the module
 * under test.
 */

import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decodeTransaction } from './transactionParser.js';

// ---------------------------------------------------------------------------
// Verified raw-hex fixtures  (must remain single-line strings)
// ---------------------------------------------------------------------------

/** Genesis coinbase — txid 4a5e1e4b... */
const GENESIS_COINBASE_HEX =
  '01000000010000000000000000000000000000000000000000000000000000000000000000' +
  'ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f323030392043' +
  '68616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f7574' +
  '20666f722062616e6b73ffffffff0100f2052a01000000434104678afdb0fe5548271967' +
  'f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec' +
  '112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000';

/** Synthetic legacy P2PKH v2 tx — txid f18925bf... */
const LEGACY_P2PKH_HEX =
  '02000000013ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e' +
  '4a000000005b47304402abcdef01234567890a0b0c0d0e0f101112131415161718191a1b' +
  '1c1d1e1f202122232425262728292a2b0220abcdef01234567890a0b0c0d0e0f10111213' +
  '1415161718191a1b1c1d1e1f202122232425262728292a2b01ffffffff0200e1f5050000' +
  '00001976a914abababababababababababababababababababab88ac80f0fa020000000019' +
  '76a914cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd88ac00000000';

/** Synthetic SegWit P2WPKH v1 tx — txid (non-witness) fab2703f... */
const SEGWIT_P2WPKH_HEX =
  '010000000001013ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b' +
  '1e5e4a0000000000fdffffff01c09ee60500000000160014aaaaaaaaaaaaaaaaaaaaaaaaa' +
  'aaaaaaaaaaaaaaaa024731313131313131313131313131313131313131313131313131313' +
  '131313131313131313131313131313131313131313131313131313131313131313131313' +
  '131313131313131312102abababababababababababababababababababababababababababab' +
  'ababababab00000000';
