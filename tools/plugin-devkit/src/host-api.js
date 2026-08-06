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
  const cacheStore = new Map();
  const runtimeInfo = {
    pluginApiVersion: 4,
    hostApiVersion: 3,
    engine: 'node-vm',
    engineVersion: process.version,
    supportedHostApis: [
      'app.info',
      'app.userAgent',
      'runtime.info',
      'cache.get',
      'cache.set',
      'cache.remove',
      'cache.clear',
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
      'xml.getRootAttributes',
      'xml.findElements',
      'xml.replaceChildrenByAttr',
      'xml.removeElements',
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
      cache: {
        get: key => cacheGet(cacheStore, key),
        set: (key, value, ttlMs) => cacheSet(cacheStore, key, value, ttlMs),
        remove: key => {
          cacheStore.delete(String(key || ''));
          return '';
        },
        clear: () => {
          cacheStore.clear();
          return '';
        }
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
      xml: {
        getRootAttributes: xml => getXmlRootAttributes(xml),
        findElements: (xml, query) => findXmlElements(xml, query),
        replaceChildrenByAttr: (xml, xmlOptions) => replaceXmlChildrenByAttr(xml, xmlOptions),
        removeElements: (xml, query) => removeXmlElements(xml, query)
      },
      log: {
        debug: (tag, message) => normalizeLogCall(log, 'debug', tag, message),
        warn: (tag, message) => normalizeLogCall(log, 'warn', tag, message),
        error: (tag, message) => normalizeLogCall(log, 'error', tag, message)
      }
    }
  };
}

function cacheGet(cacheStore, key) {
  const entry = cacheStore.get(String(key || ''));
  if (!entry) return '';
  if (entry.expiresAt > 0 && entry.expiresAt <= Date.now()) {
    cacheStore.delete(String(key || ''));
    return '';
  }
  return entry.value;
}

function cacheSet(cacheStore, key, value, ttlMs) {
  const ttl = Number(ttlMs || 0);
  cacheStore.set(String(key || ''), {
    value: value == null ? '' : String(value),
    expiresAt: ttl > 0 ? Date.now() + ttl : 0
  });
  return '';
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

function getXmlRootAttributes(xml) {
  return { ...parseXml(xml).attributes };
}

function findXmlElements(xml, query = {}) {
  const root = parseXml(xml);
  const matches = [];
  walkXml(root, node => {
    if (matchesXmlQuery(node, query)) {
      matches.push(xmlNodeToObject(node));
    }
  });
  return matches;
}

function replaceXmlChildrenByAttr(xml, options = {}) {
  const original = String(xml ?? '');
  const targetTag = String(options?.targetTag ?? '');
  const keyAttr = String(options?.keyAttr ?? '');
  if (!targetTag || !keyAttr) return original;

  const root = parseXml(original);
  const rootAttributes = isPlainObject(options.rootAttributes) ? options.rootAttributes : {};
  for (const [name, value] of Object.entries(rootAttributes)) {
    root.attributes[name] = value == null ? '' : String(value);
  }

  const replacements = isPlainObject(options.replacements) ? options.replacements : {};
  walkXml(root, node => {
    if (node.type !== 'element' || node.name !== targetTag) return;
    const key = node.attributes[keyAttr] ?? '';
    if (!key || !isPlainObject(replacements[key])) return;

    const replacement = replacements[key];
    const mode = String(replacement.mode ?? '') || 'text';
    const value = replacement.value == null ? '' : String(replacement.value);
    node.children = mode === 'xml'
      ? parseXml(`<root>${value}</root>`).children
      : [xmlTextNode(value)];
  });
  return serializeXml(root);
}

function removeXmlElements(xml, query = {}) {
  const root = parseXml(xml);

  function removeFrom(node) {
    if (node.type !== 'element') return;
    node.children = node.children.filter(child => {
      if (child.type === 'element' && matchesXmlQuery(child, query)) return false;
      removeFrom(child);
      return true;
    });
  }

  removeFrom(root);
  walkXml(root, node => {
    if (node.type === 'element' && node.name === 'translations') {
      const hasElementChild = node.children.some(child => child.type === 'element');
      if (!hasElementChild) node.children = [];
    }
  });
  return serializeXml(root);
}

function parseXml(xml) {
  const input = String(xml ?? '');
  const tokenPattern = /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<\/[\s\S]*?>|<[^>]*>|[^<]+/g;
  const stack = [];
  let root = null;
  let match;

  while ((match = tokenPattern.exec(input)) !== null) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<?') || /^<!DOCTYPE/i.test(token)) {
      continue;
    }
    if (token.startsWith('<![CDATA[')) {
      if (stack.length > 0) {
        stack.at(-1).children.push(xmlTextNode(token.slice(9, -3)));
      }
      continue;
    }
    if (token.startsWith('</')) {
      const closingName = token.slice(2, -1).trim();
      const current = stack.pop();
      if (!current || current.name !== closingName) {
        throw new Error(`Malformed XML: unexpected closing tag ${closingName}`);
      }
      continue;
    }
    if (token.startsWith('<!')) continue;
    if (token.startsWith('<')) {
      const selfClosing = /\/\s*>$/.test(token);
      const body = token.slice(1, selfClosing ? token.lastIndexOf('/') : -1).trim();
      const nameMatch = /^([^\s/>]+)/.exec(body);
      if (!nameMatch) throw new Error('Malformed XML: missing element name');
      const node = xmlElementNode(
        nameMatch[1],
        parseXmlAttributes(body.slice(nameMatch[0].length))
      );
      if (stack.length > 0) stack.at(-1).children.push(node);
      else if (root == null) root = node;
      else throw new Error('Malformed XML: multiple root elements');
      if (!selfClosing) stack.push(node);
      continue;
    }
    if (stack.length > 0 && token.length > 0) {
      stack.at(-1).children.push(xmlTextNode(decodeXmlEntities(token)));
    }
  }

  if (stack.length > 0) {
    throw new Error(`Malformed XML: unclosed tag ${stack.at(-1).name}`);
  }
  return root ?? xmlElementNode('root');
}

function parseXmlAttributes(source) {
  const attributes = {};
  let rest = source;
  while (rest.trim().length > 0) {
    rest = rest.trimStart();
    const nameMatch = /^([^\s=/>]+)/.exec(rest);
    if (!nameMatch) throw new Error('Malformed XML: invalid attribute');
    const name = nameMatch[1];
    rest = rest.slice(nameMatch[0].length).trimStart();
    if (!rest.startsWith('=')) throw new Error(`Malformed XML: missing value for attribute ${name}`);
    rest = rest.slice(1).trimStart();
    const quote = rest[0];
    if (quote !== '"' && quote !== "'") {
      throw new Error(`Malformed XML: attribute ${name} must be quoted`);
    }
    const end = rest.indexOf(quote, 1);
    if (end < 0) throw new Error(`Malformed XML: unterminated attribute ${name}`);
    attributes[name] = decodeXmlEntities(rest.slice(1, end));
    rest = rest.slice(end + 1);
  }
  return attributes;
}

function matchesXmlQuery(node, query = {}) {
  if (node.type !== 'element') return false;
  const tag = String(query?.tag ?? '');
  if (tag && node.name !== tag) return false;
  const attrs = isPlainObject(query?.attrs) ? query.attrs : {};
  return Object.entries(attrs).every(([name, value]) =>
    node.attributes[name] === (value == null ? '' : String(value))
  );
}

function xmlNodeToObject(node) {
  return {
    tag: node.name,
    attrs: { ...node.attributes },
    text: xmlTextContent(node),
    innerXml: node.children.map(serializeXml).join(''),
    children: node.children
      .filter(child => child.type === 'element')
      .map(xmlNodeToObject)
  };
}

function xmlTextContent(node) {
  if (node.type === 'text') return node.text;
  return node.children.map(xmlTextContent).join('');
}

function walkXml(node, visitor) {
  visitor(node);
  if (node.type === 'element') {
    node.children.forEach(child => walkXml(child, visitor));
  }
}

function serializeXml(node) {
  if (node.type === 'text') return escapeXmlText(node.text);
  const attributes = Object.entries(node.attributes)
    .map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`)
    .join('');
  if (node.children.length === 0) return `<${node.name}${attributes} />`;
  return `<${node.name}${attributes}>${node.children.map(serializeXml).join('')}</${node.name}>`;
}

function xmlElementNode(name, attributes = {}) {
  return { type: 'element', name, attributes, children: [] };
}

function xmlTextNode(text) {
  return { type: 'text', text: String(text ?? '') };
}

function decodeXmlEntities(value) {
  return String(value ?? '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized === 'amp') return '&';
    if (normalized === 'lt') return '<';
    if (normalized === 'gt') return '>';
    if (normalized === 'quot') return '"';
    if (normalized === 'apos') return "'";
    const codePoint = normalized.startsWith('#x')
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
  });
}

function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value) {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}
