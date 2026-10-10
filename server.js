// ARTICLE EXTRACTOR — स्वतंत्र Fetch Backend (v2)
// कोई AI API नहीं · कोई Paid Scraping API नहीं · कोई App Builder Integration Credit नहीं
// काम: छोटे लिंक का redirect चेन चलाना (हर चरण की जाँच), पेज का HTML लाना और ईमानदार जवाब देना।
// Extraction, Cleaning और Copy Buttons ऐप (ब्राउज़र) में ही चलते हैं।
import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import { TextDecoder } from 'node:util';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 8080);
const DEADLINE_MS = Number(process.env.DEADLINE_MS || 15000);
const MAX_BYTES = Number(process.env.MAX_BYTES || 3670016);
const MAX_REDIRECTS = Number(process.env.MAX_REDIRECTS || 8);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const VERSION = '2.0.0';

const REDIRECT_STATUS = [301, 302, 303, 307, 308];
const ALLOWED_PORTS = ['', '80', '443'];
const HTML_TYPES = /text\/html|application\/xhtml|text\/plain/i;
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';

export class UpstreamError extends Error {
  constructor(code, message, extra) {
    super(message || code);
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}

// ---------- SSRF सुरक्षा: private / internal पते ब्लॉक ----------
export function isPrivateAddress(address) {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    const a = parts[0];
    const b = parts[1];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  const ip = String(address).toLowerCase();
  if (ip === '::1' || ip === '::') return true;
  if (ip.startsWith('fe80') || ip.startsWith('fec0')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return true;
  if (ip.startsWith('ff')) return true;
  if (ip.startsWith('64:ff9b:')) return true;
  if (ip.startsWith('2001:db8')) return true;
  if (ip.startsWith('::ffff:')) return isPrivateAddress(ip.slice(7));
  return false;
}

// हर hop पर एक ही जाँच: सिर्फ़ http/https, सिर्फ़ पोर्ट 80/443, कोई user:password नहीं,
// और host का सार्वजनिक होना DNS से पुष्ट। http होप को https में बदला जाता है।
export async function assertPublicUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw new UpstreamError('UNSAFE_URL', 'Invalid URL: ' + rawUrl);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpstreamError('UNSAFE_URL', 'Only http and https URLs are allowed');
  }
  if (url.username || url.password) {
    throw new UpstreamError('UNSAFE_URL', 'Credentials inside the URL are not allowed');
  }
  if (ALLOWED_PORTS.indexOf(url.port) === -1) {
    throw new UpstreamError('UNSAFE_URL', 'Port not allowed: ' + (url.port || 'unknown'));
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost|.*\.onion|.*\.home|.*\.lan)$/.test(host)) {
    throw new UpstreamError('UNSAFE_URL', 'Private host blocked: ' + host);
  }

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new UpstreamError('UNSAFE_URL', 'Private address blocked: ' + host);
  } else {
    let records;
    try {
      records = await dns.lookup(host, { all: true, verbatim: true });
    } catch {
      throw new UpstreamError('SITE_UNREACHABLE', 'DNS lookup failed: ' + host);
    }
    if (!records.length) throw new UpstreamError('SITE_UNREACHABLE', 'DNS lookup returned no address: ' + host);
    for (const record of records) {
      if (isPrivateAddress(record.address)) {
        throw new UpstreamError('UNSAFE_URL', 'Private network destination blocked: ' + host);
      }
    }
  }

  if (url.protocol === 'http:') {
    const secure = new URL(url.toString());
    secure.protocol = 'https:';
    if (url.port === '80') secure.port = '';
    return secure;
  }
  return url;
}

function statusCodeFor(status) {
  if (status === 401 || status === 403) return 'AUTH_REQUIRED';
  if (status === 402 || status === 451) return 'PAYWALL';
  if (status === 404 || status === 410) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'SERVER_ERROR';
  return 'UPSTREAM_ERROR';
}

function decodeBody(buffer, contentType) {
  const match = /charset=["']?([\w-]+)/i.exec(contentType || '');
  try {
    return new TextDecoder(match ? match[1] : 'utf-8').decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

// Response size limit लागू करते हुए पूरा body पढ़ता है (बड़ा body बीच में ही काट दिया जाता है)।
async function readLimited(response, contentType) {
  const stream = response.body;
  if (!stream || typeof stream.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_BYTES) {
      throw new UpstreamError('TOO_LARGE', 'Response larger than ' + MAX_BYTES + ' bytes', { status: response.status });
    }
    return { bytes: buffer.byteLength, text: decodeBody(buffer, contentType) };
  }
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    const chunk = Buffer.from(step.value);
    size += chunk.byteLength;
    if (size > MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // stream already closed
      }
      throw new UpstreamError('TOO_LARGE', 'Response larger than ' + MAX_BYTES + ' bytes', { status: response.status });
    }
    chunks.push(chunk);
  }
  return { bytes: size, text: decodeBody(Buffer.concat(chunks), contentType) };
}

export async function fetchArticle(rawUrl, options) {
  const settings = options || {};
  const deadline = Date.now() + (settings.deadlineMs || DEADLINE_MS);
  const redirects = [];
  let target = await assertPublicUrl(rawUrl);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new UpstreamError('TIMEOUT', 'समय सीमा पार हो गई', { finalUrl: target.toString(), redirects });
    }

    const controller = new AbortController();
    const timer = setTimeout(function () {
      controller.abort();
    }, remaining);
    let response;
    try {
      response = await fetch(target, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'accept-language': 'hi-IN,hi;q=0.9,en;q=0.8',
        },
      });
    } catch (error) {
      const aborted = error && error.name === 'AbortError';
      throw new UpstreamError(aborted ? 'TIMEOUT' : 'SITE_UNREACHABLE', (error && error.message) || 'Request failed', {
        finalUrl: target.toString(),
        redirects,
      });
    } finally {
      clearTimeout(timer);
    }

    if (REDIRECT_STATUS.indexOf(response.status) !== -1) {
      const location = response.headers.get('location');
      if (!location) {
        throw new UpstreamError('NO_LOCATION', 'Redirect without Location header', {
          status: response.status,
          finalUrl: target.toString(),
          redirects,
        });
      }
      let next;
      try {
        next = new URL(location, target);
      } catch {
        throw new UpstreamError('UNSAFE_REDIRECT', 'Redirect points to an invalid address', {
          status: response.status,
          finalUrl: target.toString(),
          redirects,
        });
      }
      const safeNext = await assertPublicUrl(next.toString());
      redirects.push({ status: response.status, from: target.toString(), to: safeNext.toString() });
      target = safeNext;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      throw new UpstreamError(statusCodeFor(response.status), 'Upstream HTTP ' + response.status, {
        status: response.status,
        finalUrl: target.toString(),
        redirects,
      });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!HTML_TYPES.test(contentType)) {
      throw new UpstreamError('NOT_HTML', 'Unsupported content type: ' + (contentType || 'none'), {
        status: response.status,
        contentType,
        finalUrl: target.toString(),
        redirects,
      });
    }

    const body = await readLimited(response, contentType);
    return {
      status: response.status,
      finalUrl: target.toString(),
      contentType,
      bytes: body.bytes,
      redirects,
      html: body.text,
    };
  }

  throw new UpstreamError('TOO_MANY_REDIRECTS', 'More than ' + MAX_REDIRECTS + ' redirects', {
    finalUrl: target.toString(),
    redirects,
  });
}

export function createRequestListener() {
  return async function handle(request, response) {
    const cors = {
      'access-control-allow-origin': ALLOWED_ORIGIN,
      'access-control-allow-methods': 'GET,OPTIONS',
      'access-control-allow-headers': 'content-type',
      'cache-control': 'no-store',
    };
    const send = function (payload, status) {
      response.writeHead(status || 200, Object.assign({}, cors, { 'content-type': 'application/json; charset=utf-8' }));
      response.end(JSON.stringify(payload));
    };

    if (request.method === 'OPTIONS') {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    if (request.method !== 'GET') {
      send({ ok: false, code: 'METHOD_NOT_ALLOWED' }, 405);
      return;
    }

    let info;
    try {
      info = new URL(request.url || '/', 'http://localhost');
    } catch {
      send({ ok: false, code: 'BACKEND_ERROR' }, 400);
      return;
    }

    if (info.pathname === '/' || info.pathname === '/health') {
      send({
        ok: true,
        service: 'article-extractor-fetch',
        version: VERSION,
        usage: '/extract?url=<encoded article or short link>',
        limits: { deadlineMs: DEADLINE_MS, maxBytes: MAX_BYTES, maxRedirects: MAX_REDIRECTS },
        ai: 'none',
        integrationCredits: 'none',
      });
      return;
    }

    if (info.pathname !== '/extract') {
      send({ ok: false, code: 'NOT_FOUND_ROUTE' }, 404);
      return;
    }

    const targetUrl = info.searchParams.get('url');
    if (!targetUrl) {
      send({ ok: false, code: 'MISSING_URL' }, 400);
      return;
    }

    try {
      const result = await fetchArticle(targetUrl);
      send({
        ok: true,
        status: result.status,
        finalUrl: result.finalUrl,
        contentType: result.contentType,
        bytes: result.bytes,
        redirects: result.redirects,
        html: result.html,
      });
    } catch (error) {
      // असफलता हमेशा ok:false रहती है — HTTP 401 या अधूरे जवाब को कभी सफल नहीं कहा जाता।
      send({
        ok: false,
        code: (error && error.code) || 'BACKEND_ERROR',
        message: (error && error.message) || 'Fetch failed',
        status: error ? error.status : undefined,
        finalUrl: (error && error.finalUrl) || '',
        redirects: (error && error.redirects) || [],
      });
    }
  };
}

export function createApp() {
  return http.createServer(createRequestListener());
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  createApp().listen(PORT, function () {
    console.log('ARTICLE EXTRACTOR backend v' + VERSION + ' listening on port ' + PORT);
    console.log('health:  http://localhost:' + PORT + '/health');
    console.log('extract: http://localhost:' + PORT + '/extract?url=<encoded link>');
  });
}
