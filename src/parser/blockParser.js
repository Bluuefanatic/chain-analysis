/**
 * src/parser/blockParser.js
 *
 * Parses Bitcoin Core blk*.dat files and extracts raw block and transaction
 * data without decoding transactions.
 *
 * Bitcoin Core block file format
 * ───────────────────────────────
 * A blk*.dat file is a flat sequence of "block messages":
 *
 *   ┌──────────────┬───────────────────────────────────────────────────┐
 *   │ Field        │ Size / Notes                                      │
 *   ├──────────────┼───────────────────────────────────────────────────┤
 *   │ Magic        │ 4 bytes  — 0xF9BEB4D9 for mainnet (stored LE)    │
 *   │ Block size   │ 4 bytes  — LE uint32, bytes that follow           │
 *   │ Block header │ 80 bytes — version|prev|merkle|time|bits|nonce   │
 *   │ tx count     │ varint   — number of transactions in this block   │
 *   │ transactions │ variable — concatenated raw transaction bytes     │
 *   └──────────────┴───────────────────────────────────────────────────┘
 *
 * Section between block messages may contain null-byte padding.
 *
 * Bitcoin Core v28+ XOR obfuscation
 * ───────────────────────────────────
 * Raw bytes in the file are XOR'd with a short key stored in xor.dat.
 * Call loadXorKey(xorPath) then pass the result as the second argument
 * to parseBlockFile() to deobfuscate transparently.
 *
 * Public API
 * ──────────
 *   parseBlockFile(blkPath, xorKey?)  → { blocks }
 *   loadXorKey(xorPath)               → Buffer | null
 *
 * The following helpers are also exported so that higher-level modules
 * and unit tests can use them directly:
 *   readVarInt(buf, offset)  → { value: number, size: number }
 *   measureTx(buf, offset)   → number   (byte length of the transaction)
 *   hash256Hex(buf)          → string   (double-SHA256, reversed, as hex)
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Mainnet block magic stored as a LE uint32 in the file. */
const MAINNET_MAGIC = 0xd9b4bef9;

// ── Low-level primitives ──────────────────────────────────────────────────────

/**
 * Read a Bitcoin variable-length integer from buf at the given byte offset.
 *
 * Encoding rules (Bitcoin wire protocol):
 *   0x00–0xFC  → 1-byte value
 *   0xFD       → next 2 bytes are the value (LE uint16)
 *   0xFE       → next 4 bytes are the value (LE uint32)
 *   0xFF       → next 8 bytes are the value (LE uint64, returned as Number)
 *                (safe up to 2^53; no realistic Bitcoin object has more items)
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: number, size: number }}
 */
export function readVarInt(buf, offset) {
  const first = buf[offset];

  if (first < 0xfd) {
    return { value: first, size: 1 };
  }
  if (first === 0xfd) {
    return { value: buf.readUInt16LE(offset + 1), size: 3 };
  }
  if (first === 0xfe) {
    return { value: buf.readUInt32LE(offset + 1), size: 5 };
  }
  // 0xff — 8-byte little-endian uint64
  const lo = buf.readUInt32LE(offset + 1);
  const hi = buf.readUInt32LE(offset + 5);
  return { value: hi * 0x1_0000_0000 + lo, size: 9 };
}

/**
 * Compute double-SHA256 of buf and return the result reversed as a hex string.
 *
 * Bitcoin conventionally displays block hashes and txids with byte order
 * reversed relative to the raw digest (little-endian display).
 *
 * @param {Buffer} buf
 * @returns {string} 64-char lowercase hex string
 */
export function hash256Hex(buf) {
  const first = createHash('sha256').update(buf).digest();
  const second = createHash('sha256').update(first).digest();
  // Reverse in-place: Buffer.reverse() is available in Node.js >= 6
  return Buffer.from(second).reverse().toString('hex');
}

// ── Transaction length measurement ───────────────────────────────────────────

/**
 * Walk a raw serialized transaction starting at buf[offset] and return the
 * total number of bytes it occupies.  The transaction is NOT decoded — this
 * function only advances internal byte counters.
 *
 * Supports both legacy (pre-SegWit) and BIP-141 SegWit format.  SegWit is
 * detected by the marker byte (0x00) and flag byte (0x01) that immediately
 * follow the 4-byte version field.
 *
 * Transaction wire format (legacy):
 *   version(4) | inCount(varint) | inputs | outCount(varint) | outputs | locktime(4)
 *
 * Transaction wire format (SegWit, BIP-141):
 *   version(4) | marker(0x00) | flag(0x01) | inCount(varint) | inputs |
 *   outCount(varint) | outputs | witness_per_input | locktime(4)
 *
 * @param {Buffer} buf    Buffer containing at least the full transaction.
 * @param {number} offset Start position of the transaction within buf.
 * @returns {number} Byte length of the transaction.
 */
export function measureTx(buf, offset) {
  const start = offset;

  // ── Version (int32 LE, 4 bytes) ──────────────────────────────────────────
  offset += 4;

  // ── SegWit detection ─────────────────────────────────────────────────────
  // BIP-141: after version, marker=0x00 followed by flag≥0x01 signals SegWit.
  const segwit = buf[offset] === 0x00 && buf[offset + 1] === 0x01;
  if (segwit) offset += 2; // skip marker + flag

  // ── Inputs ───────────────────────────────────────────────────────────────
  const { value: inCount, size: inViSize } = readVarInt(buf, offset);
  offset += inViSize;

  for (let i = 0; i < inCount; i++) {
    offset += 32; // previous txid (hash256)
    offset += 4;  // previous output index (vout)

    const { value: scriptLen, size: scriptViSize } = readVarInt(buf, offset);
    offset += scriptViSize + scriptLen; // scriptSig (empty for native SegWit)

    offset += 4; // sequence
  }

  // ── Outputs ──────────────────────────────────────────────────────────────
  const { value: outCount, size: outViSize } = readVarInt(buf, offset);
  offset += outViSize;

  for (let i = 0; i < outCount; i++) {
    offset += 8; // value (int64 LE, satoshis)

    const { value: scriptLen, size: scriptViSize } = readVarInt(buf, offset);
    offset += scriptViSize + scriptLen; // scriptPubKey
  }

  // ── Witness data (SegWit only, one stack per input) ───────────────────────
  if (segwit) {
    for (let i = 0; i < inCount; i++) {
      const { value: stackItems, size: stackViSize } = readVarInt(buf, offset);
      offset += stackViSize;

      for (let j = 0; j < stackItems; j++) {
        const { value: itemLen, size: itemViSize } = readVarInt(buf, offset);
        offset += itemViSize + itemLen;
      }
    }
  }

  // ── Locktime (uint32 LE, 4 bytes) ────────────────────────────────────────
  offset += 4;

  return offset - start;
}

// ── XOR obfuscation (Bitcoin Core v28+) ──────────────────────────────────────

/**
 * Load the XOR obfuscation key from a Bitcoin Core xor.dat file.
 *
 * Bitcoin Core v28 introduced per-block-file XOR obfuscation.  The key is
 * stored in xor.dat in the same data directory as the blk*.dat files.  When
 * all bytes in xor.dat are zero (or the file is empty) the data directory is
 * not obfuscated and this function returns null.
 *
 * @param {string} xorPath Absolute or relative path to xor.dat.
 * @returns {Buffer | null} The key buffer, or null if no obfuscation.
 */
export function loadXorKey(xorPath) {
  const raw = readFileSync(xorPath);
  if (raw.length === 0 || raw.every(b => b === 0)) return null;
  return raw;
}

/**
 * Apply the XOR obfuscation key to buf in-place.
 *
 * Each byte at file position (fileOffset + i) is XOR'd with
 * xorKey[(fileOffset + i) % xorKey.length].
 *
 * @param {Buffer} buf        Buffer to deobfuscate (mutated in-place).
 * @param {Buffer} xorKey     Key from loadXorKey().
 * @param {number} fileOffset Byte offset of buf[0] within the original file.
 * @returns {Buffer} The same buf, now deobfuscated.
 */
function applyXor(buf, xorKey, fileOffset = 0) {
  const keyLen = xorKey.length;
  for (let i = 0; i < buf.length; i++) {
    buf[i] ^= xorKey[(fileOffset + i) % keyLen];
  }
  return buf;
}

// ── Block file parser ────────────────────────────────────────────────────────

/**
 * Parse a Bitcoin Core blk*.dat file and return all blocks found in it.
 *
 * Each block entry contains:
 *   block_hash        — double-SHA256 of the 80-byte header (hex, reversed)
 *   timestamp         — UNIX timestamp from the block header (seconds)
 *   raw_transactions  — array of Buffers, one per transaction (raw bytes,
 *                       ready to be fed into a transaction decoder)
 *
 * The function reads the entire file into memory then walks it linearly.
 * Fixture files are at most ~128 MiB, well within Node.js heap defaults.
 *
 * @param {string}      blkPath  Path to the blk*.dat file.
 * @param {Buffer|null} [xorKey] Optional deobfuscation key from loadXorKey().
 *                               Pass null (default) when the data directory
 *                               is not obfuscated.
 * @returns {{
 *   blocks: Array<{
 *     block_hash:        string,
 *     timestamp:         number,
 *     raw_transactions:  Buffer[]
 *   }>
 * }}
 */
export function parseBlockFile(blkPath, xorKey = null) {
  // Read the whole file; apply XOR deobfuscation if a key was provided.
  const fileData = readFileSync(blkPath);
  const buf = xorKey
    ? applyXor(Buffer.from(fileData), xorKey, 0)
    : fileData;

  const blocks = [];
  let pos = 0;

  while (pos < buf.length) {
    // ── Skip null-byte padding ───────────────────────────────────────────
    // Bitcoin Core may pad the end of partially written block files with zeros.
    if (buf[pos] === 0x00) {
      pos++;
      continue;
    }

    // ── Block envelope ───────────────────────────────────────────────────
    // We need at least 8 bytes for the magic + size fields.
    if (pos + 8 > buf.length) {
      throw new Error(
        `Truncated block envelope at offset ${pos} in "${blkPath}" ` +
        `(${buf.length - pos} bytes remain, need 8)`
      );
    }

    // Magic (4 bytes, LE uint32)
    const magic = buf.readUInt32LE(pos);
    if (magic !== MAINNET_MAGIC) {
      throw new Error(
        `Unexpected magic 0x${magic.toString(16).padStart(8, '0')} ` +
        `at offset ${pos} in "${blkPath}" (expected 0xd9b4bef9 for mainnet)`
      );
    }
    pos += 4;

    // Block size: number of payload bytes following this field
    const blockSize = buf.readUInt32LE(pos);
    pos += 4;

    const blockStart = pos;
    const blockEnd = pos + blockSize;

    if (blockEnd > buf.length) {
      throw new Error(
        `Block at offset ${blockStart} claims size ${blockSize} but the file ` +
        `ends at offset ${buf.length} in "${blkPath}"`
      );
    }

    // ── Block header (exactly 80 bytes) ──────────────────────────────────
    // Layout (all LE):
    //   version(4) | prev_block_hash(32) | merkle_root(32) |
    //   timestamp(4) | bits(4) | nonce(4)
    if (blockStart + 80 > blockEnd) {
      throw new Error(
        `Block at offset ${blockStart} is too small for an 80-byte header ` +
        `(block size = ${blockSize})`
      );
    }

    // block_hash = double-SHA256 of the raw 80-byte header, bytes reversed
    const headerSlice = buf.subarray(blockStart, blockStart + 80);
    const block_hash = hash256Hex(headerSlice);

    // Timestamp sits at bytes 68–71 of the header (offset from block start)
    const timestamp = buf.readUInt32LE(blockStart + 68);

    // ── Transaction count (varint) ────────────────────────────────────────
    let txPos = blockStart + 80;
    const { value: txCount, size: txViSize } = readVarInt(buf, txPos);
    txPos += txViSize;

    // ── Raw transaction extraction ────────────────────────────────────────
    // We measure each transaction's byte length without decoding it, then
    // copy those bytes into an independent Buffer.  Using Buffer.from() here
    // ensures the returned buffers are not views into the large file buffer,
    // keeping memory usage predictable after the caller releases the result.
    const raw_transactions = [];

    for (let t = 0; t < txCount; t++) {
      if (txPos >= blockEnd) {
        throw new Error(
          `Expected ${txCount} transactions in block at offset ${blockStart} ` +
          `but ran out of bytes after ${t} (block ends at ${blockEnd})`
        );
      }

      const txLen = measureTx(buf, txPos);
      raw_transactions.push(Buffer.from(buf.subarray(txPos, txPos + txLen)));
      txPos += txLen;
    }

    blocks.push({ block_hash, timestamp, raw_transactions });
    pos = blockEnd;
  }

  return { blocks };
}
