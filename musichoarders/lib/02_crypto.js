// 纯 JS 实现 SHA-256 / HMAC-SHA-256。
// 宿主 Platform.crypto 只暴露 md5 + AES-ECB，没有 sha256/hmac，故在此自包含实现（不依赖宿主）。
// 算法与 Spotify 插件的 spotifySha1Bytes/spotifyHmacSha1 同构（手搓哈希 + HMAC 外层），
// 是 Lyrico 插件沙箱内做签名鉴权的既有模式。已与 node:crypto 逐字节对拍验证。

function covSha256Bytes(bytes) {
  function rotr(x, n) { return ((x >>> n) | (x << (32 - n))) >>> 0; }
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var msg = bytes.slice();
  var bitLen = msg.length * 8;
  msg.push(0x80);
  while (msg.length % 64 !== 56) msg.push(0);
  var hi = Math.floor(bitLen / 0x100000000);
  var lo = bitLen >>> 0;
  for (var i = 7; i >= 4; i--) msg.push((hi >>> (i * 8)) & 0xff);
  for (var i = 3; i >= 0; i--) msg.push((lo >>> (i * 8)) & 0xff);
  for (var off = 0; off < msg.length; off += 64) {
    var w = new Array(64);
    for (var i = 0; i < 16; i++) w[i] = (msg[off+i*4]<<24)|(msg[off+i*4+1]<<16)|(msg[off+i*4+2]<<8)|(msg[off+i*4+3]);
    for (var i = 16; i < 64; i++) {
      var s0 = rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);
      var s1 = rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);
      w[i] = (w[i-16]+s0+w[i-7]+s1)>>>0;
    }
    var a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (var i = 0; i < 64; i++) {
      var S1 = rotr(e,6)^rotr(e,11)^rotr(e,25);
      var ch = (e&f)^((~e)&g);
      var t1 = (h+S1+ch+K[i]+w[i])>>>0;
      var S0 = rotr(a,2)^rotr(a,13)^rotr(a,22);
      var maj = (a&b)^(a&c)^(b&c);
      var t2 = (S0+maj)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+b)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
  }
  var out = [];
  for (var j = 0; j < 8; j++) for (var k = 3; k >= 0; k--) out.push((H[j] >>> (k*8)) & 0xff);
  return out;
}

function covHmacSha256(keyStr, msgBytes) {
  var keyBytes = [];
  for (var i = 0; i < keyStr.length; i++) keyBytes.push(keyStr.charCodeAt(i) & 0xff);
  var block = 64;
  if (keyBytes.length > block) keyBytes = covSha256Bytes(keyBytes);
  while (keyBytes.length < block) keyBytes.push(0);
  var iKey = [], oKey = [];
  for (var i = 0; i < block; i++) {
    iKey.push(keyBytes[i] ^ 0x36);
    oKey.push(keyBytes[i] ^ 0x5c);
  }
  return covSha256Bytes(oKey.concat(covSha256Bytes(iKey.concat(msgBytes))));
}
