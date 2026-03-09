/**
 * src/parser/revParser.js
 *
 * Parse Bitcoin Core rev*.dat undo files and resolve prevouts for transactions.
 *
 * Bitcoin Core undo-file format
 * ─────────────────────────────
 * A rev*.dat file is paired 1:1 with the same-numbered blk*.dat file and
 * stores the "undo data" needed to revert every block in that blk file.
 * The on-disk layout mirrors the blk*.dat envelope:
 *
 *   ┌──────────────────┬───────────────────────────────────────────────────┐
 *   │ Field            │ Size / Notes                                      │
 *   ├──────────────────┼───────────────────────────────────────────────────┤
 *   │ Magic            │ 4 bytes  — 0xF9BEB4D9 (mainnet, stored LE)       │
 *   │ Size             │ 4 bytes  — LE uint32, CBlockUndo bytes + 32      │
 *   │ CBlockUndo data  │ Size-32 bytes — serialized block undo             │
 *   │ Checksum         │ 32 bytes — Hash256(block_hash ‖ CBlockUndo data) │
 *   └──────────────────┴───────────────────────────────────────────────────┘
 *
 * CBlockUndo serialization
 * ────────────────────────
 * Each block record contains undo data for every NON-COINBASE transaction:
 *
 *   CVarInt  vtxundo_count          — one entry per non-coinbase tx
 *   for each CTxUndo:
 *     CVarInt  input_count          — number of inputs in that tx
 *     for each Coin (spent UTXO):
 *       CVarInt  code               — (height << 1) | is_coinbase
 *       CVarInt  compressed_amount  — CompressAmount(value_sats)
 *       bytes    compressed_script  — CompressScript encoding (see below)
 *
 * Importantly, the coinbase transaction (index 0 in the block) has NO undo
 * entry.  So txUndos[0] corresponds to transactions[1], txUndos[1] to
 * transactions[2], etc.
 *
 * CVarInt (Bitcoin Core internal varint)
 * ──────────────────────────────────────
 * Different from the standard Bitcoin P2P CompactSize varint!
 * Each byte uses the low 7 bits for data.  The high bit (0x80) signals that
 * more bytes follow.  Values are encoded big-endian with an implicit +1 on
 * each continuation step to avoid all-zero sequences.
 *
 * Decode loop:
 *   n = (n << 7) | (byte & 0x7F)
 *   if byte & 0x80: n++, read next
 *   else: done
 *
 * CompressAmount / DecompressAmount
 * ──────────────────────────────────
 * Bitcoin Core compresses satoshi amounts by factoring out trailing decimal
 * zeros, then encoding the mantissa and exponent into a single integer that
 * is then CVarInt-encoded.
 *
 * CompressScript encoding
 * ───────────────────────
 * Special types recognised by a single type byte (0x00–0x05):
 *   0x00  P2PKH — followed by 20-byte hash160
 *   0x01  P2SH  — followed by 20-byte hash160
 *   0x02  P2PK (compressed, prefix 02) — followed by 32-byte x-coord
 *   0x03  P2PK (compressed, prefix 03) — followed by 32-byte x-coord
 *   0x04  P2PK (uncompressed, even y)  — followed by 32-byte x-coord
 *   0x05  P2PK (uncompressed, odd  y)  — followed by 32-byte x-coord
 * Non-special scripts use CVarInt(script_len + 6) followed by raw bytes.
 * Because the minimum CVarInt value for non-specials is 6, distinct from 0–5.
 *
 * Bitcoin Core v28+ XOR obfuscation
 * ───────────────────────────────────
 * The same XOR key used for blk*.dat applies to rev*.dat.  Pass the Buffer
 * returned by loadXorKey() (from blockParser.js) as xorKey.
 *
 * Public API
 * ──────────
 *   parseRevFile(revPath, xorKey?)  → { blocks }
 *     Each block: { txUndos: Array<Array<Coin>> }
 *     txUndos[i] = undo coins for transactions[i+1] (0-indexed; tx[0] is coinbase)
 *     Each Coin:  { value_sats, script_pubkey, height, is_coinbase }
 *
 *   resolvePrevouts(transaction, txUndoCoins)  → Array<{ value_sats, script_pubkey }>
 *     Maps one row from txUndos onto the transaction's vin in order.
 *     txUndoCoins = parseRevFile(…).blocks[b].txUndos[t]
 *
 * Exported low-level helpers (useful for testing and higher-level modules):
 *   readCVarInt(buf, offset)     → { value, size }
 *   decompressAmount(x)          → number (satoshis)
 *   decompressScript(buf, offset)→ { scriptPubKey: string, size: number }
 */

import { readFileSync } from 'node:fs';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAINNET_MAGIC = 0xd9b4bef9;

// ── CVarInt (Bitcoin Core internal variable-length integer) ───────────────────

/**
 * Decode a Bitcoin Core CVarInt from buf at the given byte offset.
 *
 * Unlike the P2P CompactSize varint, CVarInt uses a continuation-bit scheme
 * where each byte contributes 7 bits and bit 7 signals more bytes follow.
 * The encoding also applies an implicit +1 on continuation bytes so that
 * the all-zero byte sequence is never emitted for non-zero values.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value: number, size: number }}
 */
export function readCVarInt(buf, offset) {
    let n = 0;
    let size = 0;

    while (true) {
        if (offset + size >= buf.length) {
            throw new RangeError(
                `readCVarInt: buffer underflow at offset ${offset + size} ` +
                `(buffer length ${buf.length})`
            );
        }

        const b = buf[offset + size];
        size++;

        // n = (n << 7) | (b & 0x7F)  — accumulate 7 bits big-endian
        // Using multiplication instead of bitshift to avoid 32-bit truncation
        // for large values (heights up to ~8 M, amounts up to ~21 M compressed).
        n = n * 128 + (b & 0x7F);

        if (b & 0x80) {
            // Continuation byte: implicit +1 to undo the encoding offset
            n++;
        } else {
            break;
        }
    }

    return { value: n, size };
}

// ── CompressAmount / DecompressAmount ─────────────────────────────────────────

/**
 * Decompress a Bitcoin Core CompressAmount-encoded value back to satoshis.
 *
 * The encoding factors out trailing decimal zeros (exponent e, max 9) and
 * stores the mantissa in a compact form:
 *   x == 0          → 0 satoshis
 *   x != 0, e < 9   → x = 1 + (n*9 + d - 1)*10 + e  →  n*10^e + d*10^(e-1)?
 *   x != 0, e == 9  → x = 1 + (n - 1)*10 + 9        →  n * 10^9
 *
 * @param {number} x  Compressed value (as decoded by readCVarInt).
 * @returns {number}  Satoshi amount.
 */
export function decompressAmount(x) {
    if (x === 0) return 0;

    x--;                          // undo the +1 from CompressAmount's base offset
    const e = x % 10;             // exponent (number of trailing decimal zeros)
    x = Math.floor(x / 10);

    let n;
    if (e < 9) {
        // mantissa encodes a non-zero digit d (1–9) and a quotient
        const d = (x % 9) + 1;   // last significant decimal digit
        x = Math.floor(x / 9);
        n = x * 10 + d;
    } else {
        // e == 9: mantissa is stored directly (minus 1 offset)
        n = x + 1;
    }

    // Reconstruct: n × 10^e
    let amount = n;
    for (let i = 0; i < e; i++) amount *= 10;

    return amount;
}

// ── CompressScript / DecompressScript ─────────────────────────────────────────

/**
 * Decode a CompressScript-encoded script from buf at the given byte offset.
 *
 * Returns the reconstructed scriptPubKey as a lowercase hex string plus the
 * number of bytes consumed from buf.
 *
 * Special types 0x00–0x05 have fixed layouts; non-special scripts start with
 * a CVarInt whose value encodes script_len + 6 (values always ≥ 6, ensuring
 * no ambiguity with the special-type byte range 0–5).
 *
 * Note on uncompressed P2PK (types 0x04/0x05):
 *   Bitcoin Core stores only the 32-byte x-coordinate plus a sign bit.  Full
 *   y-coordinate recovery requires secp256k1 elliptic-curve arithmetic.  This
 *   implementation stores the x-coordinate with its 04/05 prefix and the
 *   OP_CHECKSIG opcode so that the byte length is correct and the script type
 *   can be identified, but the script bytes are NOT a valid Bitcoin script.
 *   Uncompressed P2PK outputs are essentially absent from post-2012 blocks.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ scriptPubKey: string, size: number }}
 */
export function decompressScript(buf, offset) {
    const t = buf[offset];

    // ── Special types ────────────────────────────────────────────────────────

    if (t === 0x00) {
        // P2PKH: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
        const hash = buf.subarray(offset + 1, offset + 21).toString('hex');
        return { scriptPubKey: `76a914${hash}88ac`, size: 21 };
    }

    if (t === 0x01) {
        // P2SH: OP_HASH160 <20 bytes> OP_EQUAL
        const hash = buf.subarray(offset + 1, offset + 21).toString('hex');
        return { scriptPubKey: `a914${hash}87`, size: 21 };
    }

    if (t === 0x02 || t === 0x03) {
        // Compressed P2PK: <33-byte pubkey> OP_CHECKSIG
        const prefix = t.toString(16).padStart(2, '0'); // '02' or '03'
        const xCoord = buf.subarray(offset + 1, offset + 33).toString('hex');
        return { scriptPubKey: `21${prefix}${xCoord}ac`, size: 33 };
    }

    if (t === 0x04 || t === 0x05) {
        // Uncompressed P2PK — only x-coord stored; y-coord recovery not implemented.
        // The prefix '04' (even y) or '05' (odd y) and x-coord allow type
        // classification; the actual y bytes are absent.
        const prefix = t.toString(16).padStart(2, '0'); // '04' or '05'
        const xCoord = buf.subarray(offset + 1, offset + 33).toString('hex');
        // Script form: <varint 33> <prefix> <xcoord> OP_CHECKSIG (y not recovered)
        return { scriptPubKey: `21${prefix}${xCoord}ac`, size: 33 };
    }

    // ── Non-special: CVarInt(script_len + 6) then raw script bytes ───────────
    const { value, size: cvarSize } = readCVarInt(buf, offset);
    const scriptLen = value - 6;

    if (scriptLen < 0) {
        throw new RangeError(
            `decompressScript: negative script length (CVarInt value=${value}) ` +
            `at offset ${offset}`
        );
    }

    const raw = buf.subarray(offset + cvarSize, offset + cvarSize + scriptLen).toString('hex');
    return { scriptPubKey: raw, size: cvarSize + scriptLen };
}

// ── Internal: XOR deobfuscation ───────────────────────────────────────────────

/**
 * Apply a Bitcoin Core XOR obfuscation key to buf in-place.
 * Mirrors the private applyXor in blockParser.js.
 *
 * @param {Buffer} buf
 * @param {Buffer} xorKey
 * @param {number} [fileOffset=0]
 * @returns {Buffer}
 */
function applyXor(buf, xorKey, fileOffset = 0) {
    const keyLen = xorKey.length;
    for (let i = 0; i < buf.length; i++) {
        buf[i] ^= xorKey[(fileOffset + i) % keyLen];
    }
    return buf;
}

// ── Internal: parse one UTXO coin entry ──────────────────────────────────────

/**
 * Parse a single Coin entry from an undo block.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {{ value_sats: number, script_pubkey: string,
 *             height: number, is_coinbase: boolean, size: number }}
 */
function parseCoin(buf, offset) {
    const start = offset;

    // code = (height << 1) | is_coinbase
    const { value: code, size: codeSize } = readCVarInt(buf, offset);
    offset += codeSize;

    const height = code >>> 1;
    const is_coinbase = (code & 1) === 1;

    // Compressed satoshi amount
    const { value: compressedAmt, size: amtSize } = readCVarInt(buf, offset);
    offset += amtSize;

    const value_sats = decompressAmount(compressedAmt);

    // Compressed scriptPubKey
    const { scriptPubKey: script_pubkey, size: scriptSize } = decompressScript(buf, offset);
    offset += scriptSize;

    return { value_sats, script_pubkey, height, is_coinbase, size: offset - start };
}

// ── Public: parse a rev*.dat file ────────────────────────────────────────────

/**
 * Parse a Bitcoin Core rev*.dat undo file.
 *
 * Returns one entry per block in the file.  Each entry's `txUndos` array has
 * one element per non-coinbase transaction in that block; each element is an
 * array of Coin objects (one per input of that transaction).
 *
 * The coinbase transaction (block.transactions[0]) has no undo entry.  To
 * correlate with the matching blk*.dat:
 *   blocks[b].txUndos[i]  ←→  blk blocks[b].raw_transactions[i + 1]
 *
 * @param {string}      revPath  Path to the rev*.dat file.
 * @param {Buffer|null} [xorKey] Deobfuscation key from blockParser.loadXorKey().
 *                               Pass null (default) when not obfuscated.
 * @returns {{
 *   blocks: Array<{
 *     txUndos: Array<Array<{
 *       value_sats:   number,
 *       script_pubkey: string,
 *       height:       number,
 *       is_coinbase:  boolean
 *     }>>
 *   }>
 * }}
 */
export function parseRevFile(revPath, xorKey = null) {
    const fileData = readFileSync(revPath);
    const buf = xorKey
        ? applyXor(Buffer.from(fileData), xorKey, 0)
        : Buffer.from(fileData);

    const blocks = [];
    let pos = 0;

    while (pos < buf.length) {
        // Skip null-byte padding (Bitcoin Core may pad partially-written files)
        if (buf[pos] === 0x00) {
            pos++;
            continue;
        }

        // Need at least 8 bytes for the magic + size fields
        if (pos + 8 > buf.length) break;

        // ── Record header ────────────────────────────────────────────────────
        const magic = buf.readUInt32LE(pos);
        if (magic !== MAINNET_MAGIC) {
            throw new Error(
                `parseRevFile: unexpected magic 0x${magic.toString(16).padStart(8, '0')} ` +
                `at offset ${pos} in "${revPath}" (expected 0xd9b4bef9)`
            );
        }
        pos += 4;

        // size = CBlockUndo_bytes + 32 (the 32-byte checksum is included)
        const size = buf.readUInt32LE(pos);
        pos += 4;

        const recordStart = pos;
        const recordEnd = pos + size; // points past the checksum

        // ── CBlockUndo parsing ───────────────────────────────────────────────
        // vtxundo_count: number of non-coinbase transactions
        const { value: txCount, size: txCountSize } = readCVarInt(buf, pos);
        pos += txCountSize;

        const txUndos = [];

        for (let i = 0; i < txCount; i++) {
            // Number of inputs in this non-coinbase transaction
            const { value: inputCount, size: inputCountSize } = readCVarInt(buf, pos);
            pos += inputCountSize;

            const coins = [];
            for (let j = 0; j < inputCount; j++) {
                const coin = parseCoin(buf, pos);
                pos += coin.size;
                coins.push({
                    value_sats: coin.value_sats,
                    script_pubkey: coin.script_pubkey,
                    height: coin.height,
                    is_coinbase: coin.is_coinbase,
                });
            }
            txUndos.push(coins);
        }

        // Skip past any remaining bytes in this record (checksum + any padding)
        pos = recordEnd;

        blocks.push({ txUndos });
    }

    return { blocks };
}

// ── Public: resolve prevouts for a single transaction ─────────────────────────

/**
 * Resolve the previous outputs (prevouts) for a decoded transaction.
 *
 * Takes the pre-extracted undo coins for that specific transaction (one row
 * from parseRevFile(…).blocks[blockIndex].txUndos[txIndex]) and returns the
 * prevout data in [ { value_sats, script_pubkey } ] order, matching vin[].
 *
 * Only call this for non-coinbase transactions.  The coinbase has no undo
 * entry and its vin[0].prev_txid is the all-zeros null hash.
 *
 * @param {{vin: Array<{prev_txid: string}>}} transaction
 *   Decoded transaction from decodeTransaction().
 * @param {Array<{value_sats: number, script_pubkey: string}>} txUndoCoins
 *   The undo coins for this transaction: parseRevFile(…).blocks[b].txUndos[t]
 * @returns {Array<{ value_sats: number, script_pubkey: string }>}
 * @throws {Error} When the input count in the transaction does not match the
 *                 number of undo coins.
 */
export function resolvePrevouts(transaction, txUndoCoins) {
    if (!transaction || !Array.isArray(transaction.vin)) {
        throw new TypeError('resolvePrevouts: transaction must have a vin array');
    }
    if (!Array.isArray(txUndoCoins)) {
        throw new TypeError('resolvePrevouts: txUndoCoins must be an array');
    }
    if (transaction.vin.length !== txUndoCoins.length) {
        throw new Error(
            `resolvePrevouts: input count mismatch — ` +
            `transaction has ${transaction.vin.length} input(s) but ` +
            `undo data has ${txUndoCoins.length} coin(s)`
        );
    }

    return txUndoCoins.map(coin => ({
        value_sats: coin.value_sats,
        script_pubkey: coin.script_pubkey,
    }));
}
