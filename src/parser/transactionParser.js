/**
 * src/parser/transactionParser.js
 *
 * Decode a raw Bitcoin transaction buffer into a structured object.
 *
 * Supported formats
 * ──────────────────
 *   Legacy (pre-SegWit):
 *     version(4) | inCount(varint) | inputs | outCount(varint) | outputs | locktime(4)
 *
 *   SegWit (BIP-141):
 *     version(4) | marker(0x00) | flag(0x01) | inCount(varint) | inputs |
 *     outCount(varint) | outputs | witness_per_input | locktime(4)
 *
 * Witness data is parsed and attached to each `vin` entry but does not affect
 * any of the other required fields.
 *
 * Constraints (per challenge spec)
 * ──────────────────────────────────
 *   - Scripts are NOT executed.
 *   - Signatures are NOT validated.
 *   - scriptSig and scriptPubKey are returned as hex-encoded strings
 *     (the raw bytes, no interpretation).
 *
 * txid calculation
 * ─────────────────
 * For SegWit transactions the txid is computed over the *legacy* serialization
 * (version + inputs + outputs + locktime, without marker/flag/witness).  This
 * matches Bitcoin Core's behavior and ensures txids are stable across
 * malleability variants.
 *
 * Public API
 * ──────────
 *   decodeTransaction(rawTx)  → DecodedTransaction
 *
 * Re-exported primitives (used in tests and higher-level modules)
 *   readVarInt  — imported from blockParser.js
 *   hash256Hex  — imported from blockParser.js
 */

import { createHash } from 'node:crypto';
import { readVarInt, hash256Hex } from './blockParser.js';

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Read `len` bytes from buf starting at offset and return them as a lowercase
 * hex string.  Does NOT advance the caller's cursor — that is the caller's job.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @param {number} len
 * @returns {string}
 */
function sliceHex(buf, offset, len) {
    return buf.subarray(offset, offset + len).toString('hex');
}

/**
 * Read a 32-byte txid field and return it as a reversed hex string.
 *
 * Bitcoin stores the previous txid in *byte-reversed* (internal byte order)
 * form on the wire, meaning the first byte is the last byte of the displayed
 * txid.  To produce the human-readable txid displayed on explorers we reverse
 * the bytes before encoding.
 *
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {string} 64-char lowercase hex, byte-reversed
 */
function readTxidField(buf, offset) {
    return Buffer.from(buf.subarray(offset, offset + 32)).reverse().toString('hex');
}

// ── Transaction decoder ────────────────────────────────────────────────────────

/**
 * @typedef {Object} TxInput
 * @property {string} prev_txid   - Txid of the output being spent (hex, reversed)
 * @property {number} vout        - Output index within that transaction
 * @property {string} scriptSig   - Unlocking script as a hex string (may be empty for SegWit)
 * @property {number} sequence    - Input sequence number
 * @property {string[]} [witness] - Witness stack items as hex strings (SegWit only)
 */

/**
 * @typedef {Object} TxOutput
 * @property {number} value_sats   - Output value in satoshis
 * @property {string} scriptPubKey - Locking script as a hex string
 */

/**
 * @typedef {Object} DecodedTransaction
 * @property {string}    txid   - Transaction hash (double-SHA256, reversed, hex)
 * @property {number}    version
 * @property {TxInput[]} vin
 * @property {TxOutput[]} vout
 * @property {number}    locktime
 * @property {number}    size    - Total serialized byte length (including witness)
 * @property {boolean}   segwit  - true when the transaction uses BIP-141 encoding
 */

/**
 * Decode a raw serialized Bitcoin transaction.
 *
 * @param {Buffer} rawTx  Complete raw transaction bytes (no surrounding envelope).
 * @returns {DecodedTransaction}
 * @throws {Error} When the buffer is too short, malformed, or the SegWit marker
 *                 is present but the flag byte is not 0x01.
 */
export function decodeTransaction(rawTx) {
    if (!Buffer.isBuffer(rawTx) || rawTx.length < 10) {
        throw new Error(
            `decodeTransaction: expected a Buffer of at least 10 bytes, ` +
            `got ${Buffer.isBuffer(rawTx) ? rawTx.length : typeof rawTx} bytes`
        );
    }

    let pos = 0;

    // ── Version (int32 LE) ────────────────────────────────────────────────────
    const version = rawTx.readInt32LE(pos);
    pos += 4;

    // ── SegWit marker + flag ──────────────────────────────────────────────────
    // BIP-141: marker must be 0x00, flag must be ≥ 0x01 (in practice always 0x01).
    const segwit = rawTx[pos] === 0x00;
    if (segwit) {
        if (rawTx[pos + 1] !== 0x01) {
            throw new Error(
                `decodeTransaction: unexpected SegWit flag 0x${rawTx[pos + 1].toString(16).padStart(2, '0')} ` +
                `at offset ${pos + 1} (expected 0x01)`
            );
        }
        pos += 2; // consume marker + flag
    }

    // ── Inputs ───────────────────────────────────────────────────────────────
    const { value: inCount, size: inViSize } = readVarInt(rawTx, pos);
    pos += inViSize;

    /** @type {TxInput[]} */
    const vin = [];

    for (let i = 0; i < inCount; i++) {
        // prev_txid: 32 bytes, byte-reversed for display
        const prev_txid = readTxidField(rawTx, pos);
        pos += 32;

        // vout: uint32 LE
        const vout = rawTx.readUInt32LE(pos);
        pos += 4;

        // scriptSig: varint length prefix + raw bytes
        const { value: scriptSigLen, size: scriptSigViSize } = readVarInt(rawTx, pos);
        pos += scriptSigViSize;
        const scriptSig = sliceHex(rawTx, pos, scriptSigLen);
        pos += scriptSigLen;

        // sequence: uint32 LE
        const sequence = rawTx.readUInt32LE(pos);
        pos += 4;

        vin.push({ prev_txid, vout, scriptSig, sequence });
    }

    // ── Outputs ──────────────────────────────────────────────────────────────
    const { value: outCount, size: outViSize } = readVarInt(rawTx, pos);
    pos += outViSize;

    /** @type {TxOutput[]} */
    const vout = [];

    for (let i = 0; i < outCount; i++) {
        // value: int64 LE in satoshis.
        // BigInt is used for the read, then converted to Number.
        // The max supply is ~21e14 sat which fits safely in a JS Number (< 2^53).
        const value_sats = Number(rawTx.readBigInt64LE(pos));
        pos += 8;

        // scriptPubKey: varint length prefix + raw bytes
        const { value: spkLen, size: spkViSize } = readVarInt(rawTx, pos);
        pos += spkViSize;
        const scriptPubKey = sliceHex(rawTx, pos, spkLen);
        pos += spkLen;

        vout.push({ value_sats, scriptPubKey });
    }

    // ── Witness data (SegWit only) ────────────────────────────────────────────
    // One witness stack per input; items are attached directly to the vin entry.
    if (segwit) {
        for (let i = 0; i < inCount; i++) {
            const { value: stackItems, size: stackViSize } = readVarInt(rawTx, pos);
            pos += stackViSize;

            /** @type {string[]} */
            const witness = [];
            for (let j = 0; j < stackItems; j++) {
                const { value: itemLen, size: itemViSize } = readVarInt(rawTx, pos);
                pos += itemViSize;
                witness.push(sliceHex(rawTx, pos, itemLen));
                pos += itemLen;
            }

            vin[i].witness = witness;
        }
    }

    // ── Locktime (uint32 LE) ──────────────────────────────────────────────────
    const locktime = rawTx.readUInt32LE(pos);
    pos += 4;

    if (pos !== rawTx.length) {
        throw new Error(
            `decodeTransaction: consumed ${pos} bytes but rawTx is ${rawTx.length} bytes ` +
            `(${rawTx.length - pos} trailing bytes)`
        );
    }

    // ── txid ─────────────────────────────────────────────────────────────────
    // For SegWit transactions the txid is computed over the legacy serialization
    // (no marker, no flag, no witness data).  This is specified in BIP-141 §txid.
    // For legacy transactions the raw bytes are hashed directly.
    const txid = segwit
        ? hash256Hex(_legacySerialization(version, vin, vout, locktime))
        : hash256Hex(rawTx);

    return {
        txid,
        version,
        vin,
        vout,
        locktime,
        size: rawTx.length,
        segwit,
    };
}

// ── Private: legacy serialization for SegWit txid computation ─────────────────

/**
 * Re-serialize a transaction in legacy (non-SegWit) format so that we can
 * compute a BIP-141-compatible txid for SegWit transactions.
 *
 * Only called from decodeTransaction when segwit is true.
 *
 * @param {number}    version
 * @param {TxInput[]} vin       - inputs already parsed (witness ignored here)
 * @param {TxOutput[]} vout
 * @param {number}    locktime
 * @returns {Buffer}
 */
function _legacySerialization(version, vin, vout, locktime) {
    const parts = [];

    // version (4 bytes LE)
    const versionBuf = Buffer.allocUnsafe(4);
    versionBuf.writeInt32LE(version, 0);
    parts.push(versionBuf);

    // inCount varint
    parts.push(_encodeVarInt(vin.length));

    for (const input of vin) {
        // prev_txid: un-reverse the display hex back to wire order
        const prevTxidBytes = Buffer.from(input.prev_txid, 'hex').reverse();
        parts.push(prevTxidBytes);

        // vout (4 bytes LE)
        const voutBuf = Buffer.allocUnsafe(4);
        voutBuf.writeUInt32LE(input.vout, 0);
        parts.push(voutBuf);

        // scriptSig: varint + bytes
        const scriptSigBytes = Buffer.from(input.scriptSig, 'hex');
        parts.push(_encodeVarInt(scriptSigBytes.length));
        parts.push(scriptSigBytes);

        // sequence (4 bytes LE)
        const seqBuf = Buffer.allocUnsafe(4);
        seqBuf.writeUInt32LE(input.sequence, 0);
        parts.push(seqBuf);
    }

    // outCount varint
    parts.push(_encodeVarInt(vout.length));

    for (const output of vout) {
        // value (8 bytes LE int64)
        const valueBuf = Buffer.allocUnsafe(8);
        valueBuf.writeBigInt64LE(BigInt(output.value_sats), 0);
        parts.push(valueBuf);

        // scriptPubKey: varint + bytes
        const spkBytes = Buffer.from(output.scriptPubKey, 'hex');
        parts.push(_encodeVarInt(spkBytes.length));
        parts.push(spkBytes);
    }

    // locktime (4 bytes LE)
    const ltBuf = Buffer.allocUnsafe(4);
    ltBuf.writeUInt32LE(locktime, 0);
    parts.push(ltBuf);

    return Buffer.concat(parts);
}

/**
 * Encode a non-negative integer as a Bitcoin varint Buffer.
 *
 * @param {number} value
 * @returns {Buffer}
 */
function _encodeVarInt(value) {
    if (value < 0xfd) {
        return Buffer.from([value]);
    }
    if (value <= 0xffff) {
        const buf = Buffer.allocUnsafe(3);
        buf[0] = 0xfd;
        buf.writeUInt16LE(value, 1);
        return buf;
    }
    if (value <= 0xffff_ffff) {
        const buf = Buffer.allocUnsafe(5);
        buf[0] = 0xfe;
        buf.writeUInt32LE(value, 1);
        return buf;
    }
    const buf = Buffer.allocUnsafe(9);
    buf[0] = 0xff;
    buf.writeBigUInt64LE(BigInt(value), 1);
    return buf;
}
