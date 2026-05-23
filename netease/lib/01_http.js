const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.3.203419";

const AES_163_KEY = "#14ljk_!\\]&0U<'(";
const EAPI_KEY = "e82ckenh8dichen8";
const APP_VER = "3.1.3.203419";
const DEVICEID_XOR_KEY = "3go8&$8*3*3h0k(2)2";

let DEVICE_ID = randomHex(32);
let CLIENT_SIGN = generateClientSign();
let neInitialized = false;
let cookieJar = {};
let neOsVer = "Microsoft-Windows-10--build-" + randomIntRange(20000, 30000) + "-64bit";
let neMode = randomItem([
  "MS-iCraft B760M WIFI",
  "ASUS ROG STRIX Z790",
  "MSI MAG B550 TOMAHAWK",
  "ASRock X670E Taichi",
  "GIGABYTE Z790 AORUS ELITE"
]);

function randomInt(max) {
  return Math.floor(Math.random() * max);
}

function randomIntRange(min, max) {
  return min + randomInt(max - min);
}

function randomItem(items) {
  return items[randomInt(items.length)];
}

function randomHex(length) {
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars.charAt(randomInt(chars.length));
  }
  return out;
}

function randomUpper(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars.charAt(randomInt(chars.length));
  }
  return out;
}

function randomLower(length) {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < length; i++) {
    out += chars.charAt(randomInt(chars.length));
  }
  return out;
}

function randomMac() {
  const parts = [];
  for (let i = 0; i < 6; i++) {
    parts.push(randomInt(256).toString(16).padStart(2, "0").toUpperCase());
  }
  return parts.join(":");
}

function generateClientSign() {
  return randomMac() + "@@@" + randomUpper(8) + "@@@@@@" + randomHex(64);
}

function mergeObjects(a, b) {
  const out = {};
  Object.keys(a || {}).forEach(function (key) {
    out[key] = a[key];
  });
  Object.keys(b || {}).forEach(function (key) {
    out[key] = b[key];
  });
  return out;
}

function cookieString(extraCookies) {
  const merged = mergeObjects(cookieJar, extraCookies || {});
  return Object.keys(merged)
    .filter(function (key) {
      return merged[key] != null && String(merged[key]).length > 0;
    })
    .map(function (key) {
      return key + "=" + merged[key];
    })
    .join("; ");
}

function setCookieFromHeaders(headers) {
  if (!headers) return;

  const setCookies =
    headers["Set-Cookie"] ||
    headers["set-cookie"] ||
    headers["SET-COOKIE"] ||
    [];

  const list = Array.isArray(setCookies) ? setCookies : [String(setCookies)];

  list.forEach(function (line) {
    if (!line) return;

    const first = String(line).split(";")[0];
    const index = first.indexOf("=");
    if (index <= 0) return;

    const key = first.slice(0, index).trim();
    const value = first.slice(index + 1).trim();

    if (key && value) {
      cookieJar[key] = value;
    }
  });
}

/*
 * UTF-8 编码。
 * 这里不能把 XOR 后的字符串丢给宿主 md5(text)，因为字符串里可能有 NUL / 控制字符。
 */
function utf8Bytes(str) {
  const bytes = [];

  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);

    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }

    if (code <= 0x7f) {
      bytes.push(code);
    } else if (code <= 0x7ff) {
      bytes.push(
        0xc0 | (code >> 6),
        0x80 | (code & 0x3f)
      );
    } else if (code <= 0xffff) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }

  return bytes;
}

function base64EncodeBytes(bytes) {
  const table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";

  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] & 0xff;
    const b1 = i + 1 < bytes.length ? bytes[i + 1] & 0xff : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] & 0xff : 0;

    const triple = (b0 << 16) | (b1 << 8) | b2;

    out += table[(triple >> 18) & 0x3f];
    out += table[(triple >> 12) & 0x3f];
    out += i + 1 < bytes.length ? table[(triple >> 6) & 0x3f] : "=";
    out += i + 2 < bytes.length ? table[triple & 0x3f] : "=";
  }

  return out;
}

function leftRotate(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function md5Bytes(inputBytes) {
  const s = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  const k = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee,
    0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be,
    0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa,
    0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
    0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c,
    0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05,
    0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039,
    0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1,
    0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
  ];

  const bytes = inputBytes.slice();
  const bitLength = bytes.length * 8;

  bytes.push(0x80);

  while ((bytes.length % 64) !== 56) {
    bytes.push(0);
  }

  let lengthLow = bitLength >>> 0;
  let lengthHigh = Math.floor(bitLength / 4294967296) >>> 0;

  for (let i = 0; i < 4; i++) {
    bytes.push((lengthLow >>> (8 * i)) & 0xff);
  }

  for (let i = 0; i < 4; i++) {
    bytes.push((lengthHigh >>> (8 * i)) & 0xff);
  }

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  for (let offset = 0; offset < bytes.length; offset += 64) {
    const m = [];

    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      m[i] =
        (bytes[j] & 0xff) |
        ((bytes[j + 1] & 0xff) << 8) |
        ((bytes[j + 2] & 0xff) << 16) |
        ((bytes[j + 3] & 0xff) << 24);
      m[i] >>>= 0;
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i++) {
      let f;
      let g;

      if (i < 16) {
        f = ((b & c) | ((~b) & d)) >>> 0;
        g = i;
      } else if (i < 32) {
        f = ((d & b) | ((~d) & c)) >>> 0;
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = (b ^ c ^ d) >>> 0;
        g = (3 * i + 5) % 16;
      } else {
        f = (c ^ (b | (~d))) >>> 0;
        g = (7 * i) % 16;
      }

      const temp = d;
      d = c;
      c = b;

      const sum = (a + f + k[i] + m[g]) >>> 0;
      b = (b + leftRotate(sum, s[i])) >>> 0;
      a = temp;
    }

    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }

  const digest = [];

  [a0, b0, c0, d0].forEach(function (word) {
    digest.push(word & 0xff);
    digest.push((word >>> 8) & 0xff);
    digest.push((word >>> 16) & 0xff);
    digest.push((word >>> 24) & 0xff);
  });

  return digest;
}

function md5HexFromBytes(bytes) {
  return md5Bytes(bytes)
    .map(function (b) {
      return (b & 0xff).toString(16).padStart(2, "0");
    })
    .join("");
}

function getAnonimousUsername(deviceId) {
  let xored = "";

  for (let i = 0; i < deviceId.length; i++) {
    const left = deviceId.charCodeAt(i);
    const right = DEVICEID_XOR_KEY.charCodeAt(i % DEVICEID_XOR_KEY.length);
    xored += String.fromCharCode(left ^ right);
  }

  const md5Digest = md5Bytes(utf8Bytes(xored));
  const base64Md5 = base64EncodeBytes(md5Digest);
  const combined = deviceId + " " + base64Md5;

  return base64EncodeBytes(utf8Bytes(combined));
}

function buildEapiParams(path, params, encryptPath, headerCookies) {
  headerCookies = headerCookies || {};

  const header = {
    clientSign: headerCookies.clientSign || CLIENT_SIGN,
    osver: headerCookies.osver || neOsVer,
    deviceId: headerCookies.deviceId || DEVICE_ID,
    os: headerCookies.os || "pc",
    appver: headerCookies.appver || APP_VER,
    requestId: String(Date.now())
  };

  const finalParams = {};
  Object.keys(params || {}).forEach(function (key) {
    finalParams[key] = params[key];
  });

  finalParams.header = JSON.stringify(header);

  if (finalParams.e_r == null) {
    finalParams.e_r = true;
  }

  const actualEncryptPath = encryptPath || path.replace("/eapi/", "/api/");
  const paramsText = JSON.stringify(finalParams);

  const digest = Platform.crypto.md5(
    "nobody" + actualEncryptPath + "use" + paramsText + "md5forencrypt"
  );

  const data =
    actualEncryptPath +
    "-36cd479b6b5-" +
    paramsText +
    "-36cd479b6b5-" +
    digest;

  return Platform.crypto.aesEcbPkcs5EncryptHex(data, EAPI_KEY);
}

function decryptEapiResponseBase64(base64) {
  if (!base64) return "";
  return Platform.crypto.aesEcbPkcs5DecryptBase64ToText(base64, EAPI_KEY);
}

function eapiRequestRaw(path, params, options) {
  options = options || {};

  if (!Platform.http || typeof Platform.http.postBytesResponse !== "function") {
    throw new Error(
      "Host API missing: Platform.http.postBytesResponse. " +
        "Update QuickJsRuntime.HOST_API_BOOTSTRAP and QuickJsHostApi."
    );
  }

  const headerCookies = options.headerCookies || options.cookies || {};

  const encryptedHex = buildEapiParams(
    path,
    params || {},
    options.encryptPath,
    headerCookies
  );

  const formBody = "params=" + encryptedHex;

  const response = Platform.http.postBytesResponse(
    "https://interface.music.163.com" + path,
    formBody,
    {
      contentType: "application/x-www-form-urlencoded",
      headers: {
        "User-Agent": USER_AGENT,
        "Referer": "https://music.163.com/",
        "Accept": "*/*",
        "Host": "interface.music.163.com",
        "Cookie": cookieString(options.cookies || {})
      },
      connectTimeoutMs: options.connectTimeoutMs || 8000,
      readTimeoutMs: options.readTimeoutMs || 12000
    }
  );

  setCookieFromHeaders(response.headers);

  const bodyBase64 = response.bodyBase64 || "";
  const decrypted = decryptEapiResponseBase64(bodyBase64);

  if (!decrypted) {
    throw new Error(
      "Empty EAPI response: path=" +
        path +
        ", http=" +
        response.code +
        ", message=" +
        (response.message || "")
    );
  }

  return decrypted;
}

function buildPreCookies() {
  return {
    os: "pc",
    deviceId: DEVICE_ID,
    osver: neOsVer,
    clientSign: CLIENT_SIGN,
    channel: "netease",
    mode: neMode,
    appver: APP_VER
  };
}

function ensureNeInit() {
  if (neInitialized) return;

  const preCookies = buildPreCookies();

  cookieJar = {};
  Object.keys(preCookies).forEach(function (key) {
    cookieJar[key] = preCookies[key];
  });

  const username = getAnonimousUsername(DEVICE_ID);

  const raw = eapiRequestRaw(
    "/eapi/register/anonimous",
    {
      username: username,
      e_r: true
    },
    {
      cookies: preCookies,
      headerCookies: preCookies
    }
  );

  let root;
  try {
    root = JSON.parse(raw);
  } catch (e) {
    throw new Error("NE anonymous login invalid JSON: " + raw.slice(0, 300));
  }

  if (String(root.code) !== "200") {
    throw new Error(
      "NE anonymous login failed: " +
        raw.slice(0, 300) +
        ", usernameLength=" +
        username.length +
        ", username=" +
        username +
        ", deviceId=" +
        DEVICE_ID +
        ", osver=" +
        neOsVer +
        ", mode=" +
        neMode
    );
  }

  if (!cookieJar.WNMCID) {
    cookieJar.WNMCID = randomLower(6) + "." + Date.now() + ".01.0";
  }

  neInitialized = true;

  Platform.log.debug(
    "NE",
    "Anonymous login ok, userId=" +
      String(root.userId || "") +
      ", cookies=" +
      Object.keys(cookieJar).join(",")
  );
}
function eapiRequest(path, params, encryptPath) {
  try {
    ensureNeInit();
  } catch (e) {
    Platform.log.warn(
      "NE",
      "Anonymous login failed, continue with current cookies: " +
        String(e && e.message ? e.message : e)
    );

    if (!cookieJar || Object.keys(cookieJar).length === 0) {
      const preCookies = buildPreCookies();
      cookieJar = {};
      Object.keys(preCookies).forEach(function (key) {
        cookieJar[key] = preCookies[key];
      });
    }
  }

  const raw = eapiRequestRaw(path, params || {}, {
    encryptPath: encryptPath,
    cookies: cookieJar,
    headerCookies: cookieJar
  });

  let root;
  try {
    root = JSON.parse(raw);
  } catch (e) {
    throw new Error("EAPI invalid JSON: path=" + path + ", raw=" + raw.slice(0, 300));
  }

  if (String(root.code) === "301" || String(root.code) === "401") {
    neInitialized = false;
    cookieJar = {};
    throw new Error("NE session invalid: " + raw.slice(0, 300));
  }

  return root;
}

function postForm(url, params) {
  const body = Object.keys(params || {})
    .map(function (key) {
      return encodeURIComponent(key) + "=" + encodeURIComponent(String(params[key]));
    })
    .join("&");

  const text = Platform.http.postText(url, body, {
    contentType: "application/x-www-form-urlencoded; charset=utf-8",
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": "https://music.163.com/"
    }
  });

  return JSON.parse(text);
}

function getJson(url) {
  const text = Platform.http.getText(url, {
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": "https://music.163.com/"
    }
  });

  return JSON.parse(text);
}

function formatDate(millis) {
  const value = Number(millis || 0);
  if (!value) return "";

  const d = new Date(value);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");

  return d.getFullYear() + "-" + month + "-" + day;
}