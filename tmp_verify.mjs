import { createHash } from 'node:crypto';

// Genesis coinbase  — correct canonical hex from bitcoin/bitcoin src/test/data
const GENESIS = '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff4d04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73ffffffff0100f2052a0100000043410496b538e853519c726a2c91e61ec11600ae1310f8a907786b5595ab60e44f3f2a84cc860022578b8d2e63769ef0b5e45d2c88f63f4f0374f26e4c48caab4f0043ac00000000';
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
let pos = 4+1+32+4;
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
function hash256r(b) { const a=createHash('sha256').update(b).digest(); return Buffer.from(createHash('sha256').update(a).digest()).reverse().toString('hex'); }
// just hash the whole thing to see - we need the non-witness form
// parse manually
let sp = 0;
const sver = sw.readInt32LE(sp); sp += 4;
const isSegwit = sw[sp] === 0x00;
if (isSegwit) sp += 2;
const inCnt = sw[sp++];
const inStart = sp;
for (let i=0;i<inCnt;i++){ sp+=32+4; const sl=sw[sp++]; sp+=sl+4; }
const inEnd = sp;
const outCnt = sw[sp++];
for (let i=0;i<outCnt;i++){ sp+=8; const sl=sw[sp++]; sp+=sl; }
const outEnd = sp;
// witness
for (let i=0;i<inCnt;i++){const wc=sw[sp++];for(let j=0;j<wc;j++){const wl=sw[sp++];sp+=wl;}}
sp += 4; // locktime
console.log('consumed:', sp, '/', sw.length);
// build legacy serialization
const vBuf = Buffer.allocUnsafe(4); vBuf.writeInt32LE(sver,0);
const ltBuf = Buffer.allocUnsafe(4); ltBuf.writeUInt32LE(sw.readUInt32LE(sp-4),0);
const legacy = Buffer.concat([vBuf, sw.subarray(4+2, outEnd), ltBuf]);
console.log('segwit txid (non-witness):', hash256r(legacy));
