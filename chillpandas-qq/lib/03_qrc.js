// QQ 音乐 QRC 逐字歌词解密：十六进制密文 → QQ 变种 3DES（ECB）→ zlib 解压。
// 按标准 DES（FIPS 46-3）的置换表实现，再加上 QQ 实现与标准的三处差别：
//   1. 输入、输出和密钥都按 32 位小端读写，即每 4 字节内的字节顺序相反；
//   2. 子密钥压缩置换的后半部分取 D 寄存器时偏移量是 27（标准是 28）；
//   3. S2 第 2 行第 8 列是 15（标准 14），S4 第 4 行第 6 列是 10（标准 1）。
var Qrc = Qrc || {};

Qrc.KEY = "!@#)(*$%123ZXC!@!@#)(NHL";

Qrc.IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
  62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
  57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
  61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
Qrc.FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
  38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
  36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
  34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
Qrc.P = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
  2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
Qrc.PC1_C = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36];
Qrc.PC1_D = [63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
Qrc.PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2,
  41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
Qrc.SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
Qrc.SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
    4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 15, 12, 0, 1, 10, 6, 9, 11, 5,
    0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
    13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
    10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 10, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
    4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
    9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
    1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
    7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11]
];

// 第 n 位（0 起，按 DES 的位序）所在的字节：每 4 字节内顺序相反
Qrc.byteIndex = function (n) {
  return (n >> 5) * 4 + 3 - ((n & 31) >> 3);
};

Qrc.getBit = function (bytes, n) {
  return (bytes[Qrc.byteIndex(n)] >> (7 - (n & 7))) & 1;
};

// 64 位分组拆成两个 32 位整数（高位在前），用 0/1 数组表示便于查表
Qrc.toBits = function (bytes) {
  var bits = new Array(64);
  for (var n = 0; n < 64; n++) bits[n] = Qrc.getBit(bytes, n);
  return bits;
};

Qrc.fromBits = function (bits) {
  var out = [0, 0, 0, 0, 0, 0, 0, 0];
  for (var n = 0; n < 64; n++) {
    if (bits[n]) out[Qrc.byteIndex(n)] |= 1 << (7 - (n & 7));
  }
  return out;
};

Qrc.keySchedule = function (keyBytes, decrypt) {
  var keyBits = Qrc.toBits(keyBytes);
  var c = Qrc.PC1_C.map(function (p) { return keyBits[p - 1]; });
  var d = Qrc.PC1_D.map(function (p) { return keyBits[p - 1]; });
  var subkeys = [];
  for (var round = 0; round < 16; round++) {
    for (var s = 0; s < Qrc.SHIFTS[round]; s++) {
      c.push(c.shift());
      d.push(d.shift());
    }
    // 寄存器按 32 位存放、低 4 位补 0；QQ 取 D 的位置比标准多偏移 1 位
    var dPadded = d.concat([0, 0, 0, 0]);
    var subkey = Qrc.PC2.map(function (p, j) {
      return j < 24 ? c[p - 1] : dPadded[p - 28 + 1 - 1];
    });
    subkeys[decrypt ? 15 - round : round] = subkey;
  }
  return subkeys;
};

// 用上面按位定义的置换预先生成查找表，之后每个分组只做 32 位整数运算
Qrc.tables = null;

Qrc.buildTables = function () {
  var ipL = [], ipR = [], fpHi = [], fpLo = [], sp = [];
  var p, v, i, k;
  // IP：物理字节 p 取值 v 时对 L、R 的贡献
  for (p = 0; p < 8; p++) {
    ipL.push([]); ipR.push([]);
    for (v = 0; v < 256; v++) {
      var bytes = [0, 0, 0, 0, 0, 0, 0, 0];
      bytes[p] = v;
      var bits = Qrc.toBits(bytes);
      var l = 0, r = 0;
      for (i = 0; i < 32; i++) {
        l = (l << 1) | bits[Qrc.IP[i] - 1];
        r = (r << 1) | bits[Qrc.IP[i + 32] - 1];
      }
      ipL[p].push(l >>> 0);
      ipR[p].push(r >>> 0);
    }
  }
  // FP：R‖L 的第 c 个字节取值 v 时对输出 8 字节的贡献（打包成两个 32 位整数）
  for (var c = 0; c < 8; c++) {
    fpHi.push([]); fpLo.push([]);
    for (v = 0; v < 256; v++) {
      var pre = [];
      for (i = 0; i < 64; i++) pre.push(0);
      for (k = 0; k < 8; k++) pre[c * 8 + k] = (v >> (7 - k)) & 1;
      var out = Qrc.fromBits(Qrc.FP.map(function (q) { return pre[q - 1]; }));
      fpHi[c].push(((out[0] << 24) | (out[1] << 16) | (out[2] << 8) | out[3]) >>> 0);
      fpLo[c].push(((out[4] << 24) | (out[5] << 16) | (out[6] << 8) | out[7]) >>> 0);
    }
  }
  // SP：第 box 个 S 盒的 6 位输入 → 经 P 置换后的 32 位输出
  for (var box = 0; box < 8; box++) {
    sp.push([]);
    for (var x = 0; x < 64; x++) {
      var sv = Qrc.SBOX[box][((((x >> 5) << 1) | (x & 1)) * 16) + ((x >> 1) & 15)];
      var sbits = [];
      for (i = 0; i < 32; i++) sbits.push(0);
      for (k = 0; k < 4; k++) sbits[box * 4 + k] = (sv >> (3 - k)) & 1;
      var pv = 0;
      for (i = 0; i < 32; i++) pv = (pv << 1) | sbits[Qrc.P[i] - 1];
      sp[box].push(pv >>> 0);
    }
  }
  // E 扩展的第 i 组 6 位 = R 循环左移 (4i-1) 位后的最高 6 位
  var rot = [];
  for (i = 0; i < 8; i++) rot.push((4 * i + 31) % 32);
  return { ipL: ipL, ipR: ipR, fpHi: fpHi, fpLo: fpLo, sp: sp, rot: rot };
};

// 子密钥（48 位数组）→ 每个 S 盒对应的 6 位整数
Qrc.packSubkeys = function (subkeys) {
  return subkeys.map(function (bits) {
    var chunks = [];
    for (var box = 0; box < 8; box++) {
      var n = 0;
      for (var i = 0; i < 6; i++) n = (n << 1) | bits[box * 6 + i];
      chunks.push(n);
    }
    return chunks;
  });
};

Qrc.cryptBlockFast = function (block, sk, t) {
  var l = 0, r = 0, p;
  for (p = 0; p < 8; p++) {
    l |= t.ipL[p][block[p]];
    r |= t.ipR[p][block[p]];
  }
  for (var round = 0; round < 16; round++) {
    var keys = sk[round];
    var f = 0;
    for (var box = 0; box < 8; box++) {
      var n = t.rot[box];
      var rotated = ((r << n) | (r >>> (32 - n))) >>> 0;
      f ^= t.sp[box][(rotated >>> 26) ^ keys[box]];
    }
    var next = (l ^ f) >>> 0;
    l = r;
    r = next;
  }
  var hi = 0, lo = 0;
  for (var c = 0; c < 8; c++) {
    var b = c < 4 ? (r >>> (24 - 8 * c)) & 255 : (l >>> (24 - 8 * (c - 4))) & 255;
    hi |= t.fpHi[c][b];
    lo |= t.fpLo[c][b];
  }
  block[0] = (hi >>> 24) & 255; block[1] = (hi >>> 16) & 255; block[2] = (hi >>> 8) & 255; block[3] = hi & 255;
  block[4] = (lo >>> 24) & 255; block[5] = (lo >>> 16) & 255; block[6] = (lo >>> 8) & 255; block[7] = lo & 255;
  return block;
};

Qrc.schedules = null;

Qrc.decryptBytes = function (bytes) {
  if (!Qrc.schedules) {
    var key = [];
    for (var i = 0; i < Qrc.KEY.length; i++) key.push(Qrc.KEY.charCodeAt(i) & 0xff);
    Qrc.tables = Qrc.buildTables();
    Qrc.schedules = [
      Qrc.packSubkeys(Qrc.keySchedule(key.slice(16, 24), true)),
      Qrc.packSubkeys(Qrc.keySchedule(key.slice(8, 16), false)),
      Qrc.packSubkeys(Qrc.keySchedule(key.slice(0, 8), true))
    ];
  }
  var t = Qrc.tables;
  var out = [];
  var block = [0, 0, 0, 0, 0, 0, 0, 0];
  for (var offset = 0; offset + 8 <= bytes.length; offset += 8) {
    for (var j = 0; j < 8; j++) block[j] = bytes[offset + j];
    Qrc.cryptBlockFast(block, Qrc.schedules[0], t);
    Qrc.cryptBlockFast(block, Qrc.schedules[1], t);
    Qrc.cryptBlockFast(block, Qrc.schedules[2], t);
    for (j = 0; j < 8; j++) out.push(block[j]);
  }
  return out;
};

// 十六进制密文 → QRC 文本（XML）；不是 QRC 密文时返回空字符串
Qrc.decrypt = function (hex) {
  var clean = String(hex || "").replace(/[^0-9A-Fa-f]/g, "");
  if (clean.length < 16 || clean.length % 16 !== 0) return "";
  var bytes = [];
  for (var i = 0; i < clean.length; i += 2) bytes.push(parseInt(clean.substr(i, 2), 16));
  return Platform.compression.inflateBytesToText(Qrc.decryptBytes(bytes));
};
