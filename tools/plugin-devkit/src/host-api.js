import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

export function createHostApi(options = {}) {
  const logs = [];
  const appInfo = {
    name: 'Lyrico',
    packageName: 'com.lonx.lyrico',
    versionName: '0.0.0-devkit',
    versionCode: 0,
    buildType: 'desktop-devkit',
    debug: true
  };
  const runtimeInfo = {
    pluginApiVersion: 1,
    hostApiVersion: 2,
    engine: 'node-vm',
    engineVersion: process.version,
    supportedHostApis: [
      'app.info',
      'app.userAgent',
      'runtime.info',
      'crypto.md5',
      'crypto.aesEcbPkcs5EncryptBase64',
      'crypto.aesEcbPkcs5EncryptHex',
      'crypto.aesEcbPkcs5DecryptBase64ToText',
      'base64.encodeText',
      'base64.decodeText',
      'base64.dropBytes',
      'base64.decodeBytes',
      'base64.encodeBytes',
      'base64.encodeUrlText',
      'base64.decodeUrlText',
      'base64.encodeUrlBytes',
      'base64.decodeUrlBytes',
      'base64.toUrl',
      'base64.fromUrl',
      'bytes.xor',
      'bytes.xorBase64',
      'compression.inflateBytesToText',
      'compression.inflateBase64ToText',
      'http.getText',
      'http.postText',
      'http.postBytes',
      'http.get',
      'http.post',
      'http.getBytes',
      'http.postBytesResponse',
      'log.debug',
      'log.warn',
      'log.error'
    ].sort()
  };

  function log(level, tag, message) {
    const entry = {
      level,
      tag: String(tag || 'PlatformPlugin').slice(0, 48),
      message: String(message || '')
    };
    logs.push(entry);
    if (options.echoLogs) {
      console.error(`[plugin ${level}] ${entry.tag}: ${entry.message}`);
    }
    return '';
  }

  return {
    logs,
    api: {
      app: {
        getInfo: () => appInfo,
        getUserAgent: () => `${appInfo.name}/${appInfo.versionName}`
      },
      runtime: {
        getInfo: () => runtimeInfo
      },
      crypto: {
        md5: text => crypto.createHash('md5').update(String(text || ''), 'utf8').digest('hex'),
        aesEcbPkcs5EncryptBase64: (text, key) => aesEcb(text, key, 'base64'),
        aesEcbPkcs5EncryptHex: (text, key) => aesEcb(text, key, 'hex').toUpperCase(),
        aesEcbPkcs5DecryptBase64ToText: (base64, key) => aesEcbDecrypt(base64, key)
      },
      base64: {
        encodeText: text => Buffer.from(String(text || ''), 'utf8').toString('base64'),
        decodeText: base64 => Buffer.from(String(base64 || ''), 'base64').toString('utf8'),
        dropBytes: (base64, count) => Buffer.from(String(base64 || ''), 'base64').subarray(Number(count) || 0).toString('base64'),
        decodeBytes: base64 => Array.from(Buffer.from(String(base64 || ''), 'base64')),
        encodeBytes: bytes => Buffer.from(Array.from(bytes || [])).toString('base64'),
        encodeUrlText: text => Buffer.from(String(text || ''), 'utf8').toString('base64url'),
        decodeUrlText: base64Url => Buffer.from(String(base64Url || ''), 'base64url').toString('utf8'),
        encodeUrlBytes: bytes => Buffer.from(Array.from(bytes || [])).toString('base64url'),
        decodeUrlBytes: base64Url => Array.from(Buffer.from(String(base64Url || ''), 'base64url')),
        toUrl: base64 => String(base64 || '').trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
        fromUrl: base64Url => padBase64(String(base64Url || '').trim().replace(/-/g, '+').replace(/_/g, '/'))
      },
      bytes: {
        xor: (bytes, key) => xorBytes(Array.from(bytes || []), Array.from(key || [])),
        xorBase64: (base64, key) => Buffer.from(xorBytes(Array.from(Buffer.from(String(base64 || ''), 'base64')), Array.from(key || []))).toString('base64')
      },
      compression: {
        inflateBytesToText: bytes => zlib.inflateSync(Buffer.from(Array.from(bytes || []))).toString('utf8'),
        inflateBase64ToText: base64 => zlib.inflateSync(Buffer.from(String(base64 || ''), 'base64')).toString('utf8')
      },
      http: {
        getText: (url, httpOptions) => executeHttp('GET', url, null, httpOptions, false).body,
        postText: (url, body, httpOptions) => executeHttp('POST', url, body, httpOptions, false).body,
        postBytes: (url, body, httpOptions) => executeHttp('POST', url, body, httpOptions, true).bodyBase64,
        get: (url, httpOptions) => executeHttp('GET', url, null, httpOptions, false),
        post: (url, body, httpOptions) => executeHttp('POST', url, body, httpOptions, false),
        getBytes: (url, httpOptions) => executeHttp('GET', url, null, httpOptions, true),
        postBytesResponse: (url, body, httpOptions) => executeHttp('POST', url, body, httpOptions, true)
      },
      log: {
        debug: (tag, message) => normalizeLogCall(log, 'debug', tag, message),
        warn: (tag, message) => normalizeLogCall(log, 'warn', tag, message),
        error: (tag, message) => normalizeLogCall(log, 'error', tag, message)
      }
    }
  };
}

function aesEcb(text, key, encoding) {
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(String(key || ''), 'utf8'), null);
  cipher.setAutoPadding(true);
  return Buffer.concat([
    cipher.update(String(text || ''), 'utf8'),
    cipher.final()
  ]).toString(encoding);
}

function aesEcbDecrypt(base64, key) {
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from(String(key || ''), 'utf8'), null);
  decipher.setAutoPadding(true);
  return Buffer.concat([
    decipher.update(Buffer.from(String(base64 || ''), 'base64')),
    decipher.final()
  ]).toString('utf8');
}

function xorBytes(bytes, key) {
  if (key.length === 0) return bytes;
  return bytes.map((byte, index) => (byte ^ key[index % key.length]) & 0xff);
}

function padBase64(base64) {
  const remainder = base64.length % 4;
  if (remainder === 2) return `${base64}==`;
  if (remainder === 3) return `${base64}=`;
  return base64;
}

function normalizeLogCall(log, level, tag, message) {
  if (message === undefined) {
    message = tag;
    tag = 'PlatformPlugin';
  }
  return log(level, tag, message);
}

function executeHttp(method, url, body, options = {}, binaryResponse = false) {
  options = options || {};
  const headers = { ...(options.headers || {}) };
  if (!hasHeader(headers, 'User-Agent')) {
    headers['User-Agent'] = 'Lyrico/0.0.0-devkit';
  }

  let requestBody = null;
  if (method !== 'GET') {
    if (options.bodyBase64) {
      requestBody = Buffer.from(String(options.bodyBase64), 'base64');
    } else if (options.bodyBytes) {
      requestBody = Buffer.from(Array.from(options.bodyBytes));
    } else {
      requestBody = body == null ? '' : String(body);
    }
    headers['Content-Type'] = options.contentType || headers['Content-Type'] || (binaryResponse ? 'application/octet-stream' : 'application/json; charset=utf-8');
  }

  const marker = '\n__LYRICO_STATUS__:%{http_code}:%{errormsg}';
  const args = [
    '--silent',
    '--show-error',
    '--globoff',
    '--request',
    method,
    '--max-time',
    String(Math.ceil(Number(options.readTimeoutMs || options.connectTimeoutMs || 12000) / 1000)),
    '--write-out',
    marker
  ];
  if (options.followRedirects !== false) args.push('--location');
  for (const [key, value] of Object.entries(headers)) {
    args.push('--header', `${key}: ${headerString(value)}`);
  }
  if (method !== 'GET') {
    args.push('--data-binary', '@-');
  }
  args.push(String(url || ''));

  const result = spawnSync('curl', args, {
    input: requestBody ?? undefined,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`curl failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr || '');
    throw new Error(`curl exited with ${result.status}: ${stderr.trim()}`);
  }

  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout), 'utf8');
  const markerPrefix = Buffer.from('\n__LYRICO_STATUS__:', 'utf8');
  const markerIndex = stdout.lastIndexOf(markerPrefix);
  const bodyBytes = markerIndex >= 0 ? stdout.subarray(0, markerIndex) : stdout;
  const statusText = markerIndex >= 0 ? stdout.subarray(markerIndex + markerPrefix.length).toString('utf8') : '0:';
  const [codeText, ...messageParts] = statusText.split(':');
  const code = Number(codeText) || 0;
  const message = messageParts.join(':') || '';
  return {
    code,
    message,
    headers: {},
    body: binaryResponse ? '' : bodyBytes.toString('utf8'),
    bodyBase64: binaryResponse ? bodyBytes.toString('base64') : ''
  };
}

function hasHeader(headers, target) {
  return Object.keys(headers).some(key => key.toLowerCase() === target.toLowerCase() && String(headers[key]).trim() !== '');
}

function headerString(value) {
  if (Array.isArray(value)) return value.join(', ');
  return String(value ?? '');
}
