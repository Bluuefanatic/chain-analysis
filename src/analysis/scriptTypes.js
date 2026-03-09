/**
 * src/analysis/scriptTypes.js
 *
 * Detect the standard Bitcoin scriptPubKey type from its hex encoding.
 *
 * Supported types (BIP-141, BIP-341, BIP-16, BIP-13)
 * ────────────────────────────────────────────────────
 *   p2pkh     — Pay-to-Public-Key-Hash  (legacy)
 *   p2sh      — Pay-to-Script-Hash      (BIP-16)
 *   p2wpkh    — Pay-to-Witness-Public-Key-Hash  (BIP-141, native SegWit v0, 20-byte program)
 *   p2wsh     — Pay-to-Witness-Script-Hash      (BIP-141, native SegWit v0, 32-byte program)
 *   p2tr      — Pay-to-Taproot         (BIP-341, SegWit v1, 32-byte x-only pubkey)
 *   op_return — Provably unspendable data-carrier output
 *   unknown   — Any script that does not match the above templates
 *
 * Template byte patterns (hex)
 * ────────────────────────────
 *   P2PKH     76 a9 14 <20B> 88 ac            (25 bytes)
 *   P2SH      a9 14 <20B> 87                  (23 bytes)
 *   P2WPKH    00 14 <20B>                     (22 bytes)
 *   P2WSH     00 20 <32B>                     (34 bytes)
 *   P2TR      51 20 <32B>                     (34 bytes)
 *   OP_RETURN 6a …                            (≥1 byte, first byte 0x6a)
 *
 * Public API
 * ──────────
 *   detectScriptType(scriptPubKey) → ScriptType
 *
 *   scriptPubKey — lowercase hex string (no 0x prefix)
 */

/**
 * @typedef {'p2pkh'|'p2sh'|'p2wpkh'|'p2wsh'|'p2tr'|'op_return'|'unknown'} ScriptType
 */

// ── Byte-length constants (each byte = 2 hex chars) ──────────────────────────

const HEX_P2PKH_LEN  = 25 * 2; // 76 a9 14 <20B> 88 ac
const HEX_P2SH_LEN   = 23 * 2; // a9 14 <20B> 87
const HEX_P2WPKH_LEN = 22 * 2; // 00 14 <20B>
const HEX_P2WSH_LEN  = 34 * 2; // 00 20 <32B>
const HEX_P2TR_LEN   = 34 * 2; // 51 20 <32B>

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Identify the standard type of a Bitcoin scriptPubKey.
 *
 * The function operates entirely on the hex string and performs no hashing or
 * script execution.  All comparisons are case-insensitive; the input is
 * normalised to lowercase before matching.
 *
 * @param {string} scriptPubKey  ScriptPubKey as a lowercase hex string.
 * @returns {ScriptType}
 * @throws {TypeError} When the argument is not a string.
 */
export function detectScriptType(scriptPubKey) {
    if (typeof scriptPubKey !== 'string') {
        throw new TypeError(
            `detectScriptType: expected a hex string, got ${typeof scriptPubKey}`
        );
    }

    const s = scriptPubKey.toLowerCase();

    // ── P2PKH: OP_DUP OP_HASH160 OP_DATA20 <hash160> OP_EQUALVERIFY OP_CHECKSIG
    //   76 a9 14 <40 hex chars> 88 ac
    if (s.length === HEX_P2PKH_LEN &&
        s.startsWith('76a914') &&
        s.endsWith('88ac')) {
        return 'p2pkh';
    }

    // ── P2SH: OP_HASH160 OP_DATA20 <hash160> OP_EQUAL
    //   a9 14 <40 hex chars> 87
    if (s.length === HEX_P2SH_LEN &&
        s.startsWith('a914') &&
        s.endsWith('87')) {
        return 'p2sh';
    }

    // ── P2WPKH: OP_0 OP_DATA20 <20-byte witness program>
    //   00 14 <40 hex chars>
    if (s.length === HEX_P2WPKH_LEN && s.startsWith('0014')) {
        return 'p2wpkh';
    }

    // ── P2WSH: OP_0 OP_DATA32 <32-byte witness program>
    //   00 20 <64 hex chars>
    if (s.length === HEX_P2WSH_LEN && s.startsWith('0020')) {
        return 'p2wsh';
    }

    // ── P2TR: OP_1 OP_DATA32 <32-byte x-only pubkey>
    //   51 20 <64 hex chars>
    if (s.length === HEX_P2TR_LEN && s.startsWith('5120')) {
        return 'p2tr';
    }

    // ── OP_RETURN: first byte is 0x6a (OP_RETURN opcode)
    if (s.length >= 2 && s.startsWith('6a')) {
        return 'op_return';
    }

    return 'unknown';
}
