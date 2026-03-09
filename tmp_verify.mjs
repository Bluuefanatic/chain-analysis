import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const h256 = b => Buffer.from(
  createHash('sha256').update(createHash('sha256').update(b).digest()).digest()
).reverse().toString('hex');

// ── Genesis coinbase ─────────────────────────────────────────────────────────
const gVersion = Buffer.alloc(4); gVersion.writeInt32LE(1, 0);
const gPrevTxid = Buffer.alloc(32, 0);
const gPrevVout = Buffer.alloc(4, 0xff);
const gScriptSig = Buffer.from(
  '04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73',
  'hex'
);
const gSSLen = Buffer.from([gScriptSig.length]);
const gSeq = Buffer.alloc(4, 0xff);
const gValue = Buffer.alloc(8); gValue.writeBigInt64LE(5_000_000_000n, 0);
const gSPK = Buffer.from(
  '04678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5f',
  'hex'
);
const gSPKScript = Buffer.concat([Buffer.from([0x41]), gSPK, Buffer.from([0xac])]);
const gSPKLen = Buffer.from([gSPKScript.length]);
const gLocktime = Buffer.alloc(4);
const GENESIS = Buffer.concat([
  gVersion, Buffer.from([0x01]), gPrevTxid, gPrevVout,
  gSSLen, gScriptSig, gSeq,
  Buffer.from([0x01]), gValue, gSPKLen, gSPKScript,
  gLocktime,
]);

// ── Synthetic legacy tx (2 outputs, version=2) ───────────────────────────────
const lVersion = Buffer.alloc(4); lVersion.writeInt32LE(2, 0);
const lPrevTxid = Buffer.from('4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b', 'hex').reverse();
const lPrevVout = Buffer.alloc(4, 0);
const lScriptSig = Buffer.from(
  '47304402abcdef01234567890a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b0220abcdef01234567890a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b01',
  'hex'
);
const lSSLen = Buffer.from([lScriptSig.length]);
const lSeq = Buffer.alloc(4, 0xff);
const lV0 = Buffer.alloc(8); lV0.writeBigInt64LE(100_000_000n, 0);
const lSPK0 = Buffer.concat([Buffer.from('76a914', 'hex'), Buffer.alloc(20, 0xab), Buffer.from('88ac', 'hex')]);
const lSPK0Len = Buffer.from([lSPK0.length]);
const lV1 = Buffer.alloc(8); lV1.writeBigInt64LE(50_000_000n, 0);
const lSPK1 = Buffer.concat([Buffer.from('76a914', 'hex'), Buffer.alloc(20, 0xcd), Buffer.from('88ac', 'hex')]);
const lSPK1Len = Buffer.from([lSPK1.length]);
const lLocktime = Buffer.alloc(4);
const LEGACY = Buffer.concat([
  lVersion, Buffer.from([0x01]),
  lPrevTxid, lPrevVout, lSSLen, lScriptSig, lSeq,
  Buffer.from([0x02]),
  lV0, lSPK0Len, lSPK0,
  lV1, lSPK1Len, lSPK1,
  lLocktime,
]);

// ── Synthetic SegWit tx (P2WPKH, 1 in, 1 out) ───────────────────────────────
const swVersion = Buffer.alloc(4); swVersion.writeInt32LE(1, 0);
const swMarker = Buffer.from([0x00, 0x01]);
const swPrevTxid = Buffer.from('4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b', 'hex').reverse();
const swPrevVout = Buffer.alloc(4, 0);
const swEmptySS = Buffer.from([0x00]);
const swSeq = Buffer.alloc(4); swSeq.writeUInt32LE(0xfffffffd, 0);
const swOutVal = Buffer.alloc(8); swOutVal.writeBigInt64LE(99_000_000n, 0);
const swSPK = Buffer.concat([Buffer.from('0014', 'hex'), Buffer.alloc(20, 0xaa)]);
const swSPKLen = Buffer.from([swSPK.length]);
const swWitSig = Buffer.alloc(71, 0x31);
const swWitPubKey = Buffer.concat([Buffer.from([0x02]), Buffer.alloc(32, 0xab)]);
const swLocktime = Buffer.alloc(4);
const SEGWIT = Buffer.concat([
  swVersion, swMarker, Buffer.from([0x01]),
  swPrevTxid, swPrevVout, swEmptySS, swSeq,
  Buffer.from([0x01]),
  swOutVal, swSPKLen, swSPK,
  // witness for input 0: 2 items
  Buffer.from([0x02]),
  Buffer.from([swWitSig.length]), swWitSig,
  Buffer.from([swWitPubKey.length]), swWitPubKey,
  swLocktime,
]);
// segwit txid = hash of legacy serialization (no marker/flag/witness)
const swLegacy = Buffer.concat([
  swVersion, Buffer.from([0x01]),
  swPrevTxid, swPrevVout, swEmptySS, swSeq,
  Buffer.from([0x01]),
  swOutVal, swSPKLen, swSPK,
  swLocktime,
]);

const out = {
  genesis: {
    hex: GENESIS.toString('hex'),
    len: GENESIS.length,
    txid: h256(GENESIS),
    value_sats: Number(GENESIS.readBigInt64LE(4+1+32+4+1+77+4+1)),
  },
  legacy: {
    hex: LEGACY.toString('hex'),
    len: LEGACY.length,
    txid: h256(LEGACY),
  },
  segwit: {
    hex: SEGWIT.toString('hex'),
    len: SEGWIT.length,
    txid: h256(swLegacy),
  },
};

console.log(JSON.stringify(out, null, 2));
writeFileSync('tmp_fixtures.json', JSON.stringify(out, null, 2));

const gb = Buffer.from(GENESIS, 'hex');
console.log('genesis bytes:', gb.length);
const g1 = createHash('sha256').update(gb).digest();
console.log('genesis txid:', Buffer.from(createHash('sha256').update(g1).digest()).reverse().toString('hex'));

// block 170 tx
const B170 = '0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd410220181522507561a1a3dd68a73a4efd5e089c62d1b0c34b13e95b553e4f5a32a589ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac00286bee00000000434104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac00000000';
const b170 = Buffer.from(B170, 'hex');
console.log('b170 bytes:', b170.length);
const t1 = createHash('sha256').update(b170).digest();
console.log('b170 txid:', Buffer.from(createHash('sha256').update(t1).digest()).reverse().toString('hex'));
// check values
let pos = 4 + 1 + 32 + 4;
const scriptLen = b170[pos]; pos += 1 + scriptLen + 4;  // scriptSig + sequence
pos += 1; // outCount
const v0 = Number(b170.readBigInt64LE(pos)); console.log('vout[0] sats:', v0);

// segwit tx — BIP143 test vector (P2WPKH single-input)
// from https://github.com/bitcoin/bips/blob/master/bip-0143.mediawiki#native-p2wpkh
const SW = '01000000000101db6b1b20aa0fd7b23880be2ecbd4a98130974cf4748fb66092ac4d3ceb1a54770100000000fdffffff02b8b4eb0b0000000019a9142928f43af18d2d60e8a843540d8086b305341339870008af2f000000001976a914a457b684d7f0d539a46a45bbc043f35b59d0d96388ac024730440220338862b4a13d67415edbe84a3d1a33655d7ce8c5ab43e3e5b2e63ddc5bd1d1ec02205e34c76db28e4aae7d8cd19ff98a50a440fd38e8a25d42f84eef82a31d0e4ce401210399d7430cd8e0fc249e7c75a9b1c8b52b893e78dbe9d07fe8d5d71fad37c3c08400000000';
const sw = Buffer.from(SW, 'hex');
console.log('segwit bytes:', sw.length);
// txid = hash of NON-WITNESS serialization
// rebuild: version + inputs(no witness) + outputs + locktime
function hash256r(b) { const a = createHash('sha256').update(b).digest(); return Buffer.from(createHash('sha256').update(a).digest()).reverse().toString('hex'); }
// just hash the whole thing to see - we need the non-witness form
// parse manually
let sp = 0;
const sver = sw.readInt32LE(sp); sp += 4;
const isSegwit = sw[sp] === 0x00;
if (isSegwit) sp += 2;
const inCnt = sw[sp++];
const inStart = sp;
for (let i = 0; i < inCnt; i++) { sp += 32 + 4; const sl = sw[sp++]; sp += sl + 4; }
const inEnd = sp;
const outCnt = sw[sp++];
for (let i = 0; i < outCnt; i++) { sp += 8; const sl = sw[sp++]; sp += sl; }
const outEnd = sp;
// witness
for (let i = 0; i < inCnt; i++) { const wc = sw[sp++]; for (let j = 0; j < wc; j++) { const wl = sw[sp++]; sp += wl; } }
sp += 4; // locktime
console.log('consumed:', sp, '/', sw.length);
// build legacy serialization
const vBuf = Buffer.allocUnsafe(4); vBuf.writeInt32LE(sver, 0);
const ltBuf = Buffer.allocUnsafe(4); ltBuf.writeUInt32LE(sw.readUInt32LE(sp - 4), 0);
const legacy = Buffer.concat([vBuf, sw.subarray(4 + 2, outEnd), ltBuf]);
console.log('segwit txid (non-witness):', hash256r(legacy));
