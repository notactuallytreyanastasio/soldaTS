#!/usr/bin/env node
// tools/s3.mjs — zero-dependency S3 client (AWS SigV4) for Hetzner Object Storage.
//
// Used by offload-replays.mjs / fetch-replays.mjs to move replay blobs to the
// bobbby-media bucket. Path-style addressing, https only. Credentials are read
// from the environment (S3_ACCESS_KEY / S3_SECRET_KEY) or, failing that, from
// the blog repo's .env (which provisions the same bucket). Never printed.
//
// CLI (for smoke tests):
//   node tools/s3.mjs put  <localFile> <key>
//   node tools/s3.mjs head <key>
//   node tools/s3.mjs get  <key> <outFile>
//   node tools/s3.mjs list <prefix>
//   node tools/s3.mjs delete <key>

import { createHash, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import https from 'node:https';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const S3_HOST = process.env.S3_HOST || 'fsn1.your-objectstorage.com';
export const S3_REGION = process.env.S3_REGION || 'fsn1';
export const S3_BUCKET = process.env.S3_BUCKET || 'bobbby-media';

const ENV_FILE_CANDIDATES = [
  process.env.SOLDAT_S3_ENV_FILE,
  join(ROOT, '../../blog/.env'),
  join(ROOT, '../blog/.env'),
].filter(Boolean);

function loadCreds() {
  let access = process.env.S3_ACCESS_KEY || '';
  let secret = process.env.S3_SECRET_KEY || '';
  if (!access || !secret) {
    for (const file of ENV_FILE_CANDIDATES) {
      if (!existsSync(file)) continue;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?(S3_ACCESS_KEY|S3_SECRET_KEY)\s*=\s*("?)(.*?)\2\s*$/);
        if (!m) continue;
        if (m[1] === 'S3_ACCESS_KEY' && !access) access = m[3];
        if (m[1] === 'S3_SECRET_KEY' && !secret) secret = m[3];
      }
      if (access && secret) break;
    }
  }
  if (!access || !secret) {
    throw new Error('S3 credentials not found (S3_ACCESS_KEY/S3_SECRET_KEY in env or blog/.env)');
  }
  return { access, secret };
}

let CREDS = null;
function creds() {
  if (!CREDS) CREDS = loadCreds();
  return CREDS;
}

const agent = new https.Agent({ keepAlive: true, maxSockets: 32 });

const sha256hex = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// RFC 3986 encode a single path segment / query component.
function rfc3986(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

const encodeKeyPath = (key) => key.split('/').map(rfc3986).join('/');

function signedHeaders(method, path, query, payloadHash, extraHeaders = {}) {
  const { access, secret } = creds();
  const now = new Date();
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const headers = {
    host: S3_HOST,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), String(v)])),
  };

  const sortedNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedNames.map((k) => `${k}:${String(headers[k]).trim()}\n`).join('');
  const signedNames = sortedNames.join(';');

  const canonicalQuery = Object.entries(query || {})
    .map(([k, v]) => [rfc3986(k), rfc3986(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [method, path, canonicalQuery, canonicalHeaders, signedNames, payloadHash].join('\n');
  const scope = `${dateStamp}/${S3_REGION}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  let key = hmac(`AWS4${secret}`, dateStamp);
  key = hmac(key, S3_REGION);
  key = hmac(key, 's3');
  key = hmac(key, 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${access}/${scope}, SignedHeaders=${signedNames}, Signature=${signature}`;
  return { headers, canonicalQuery };
}

function request(method, key, { body = null, query = null, headers: extra = {}, timeout = 120_000 } = {}) {
  const path = `/${S3_BUCKET}${key ? '/' + encodeKeyPath(key) : ''}`;
  const payloadHash = body ? sha256hex(body) : sha256hex('');
  if (body) extra['content-length'] = body.length;
  const { headers, canonicalQuery } = signedHeaders(method, path, query, payloadHash, extra);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        agent,
        host: S3_HOST,
        method,
        path: canonicalQuery ? `${path}?${canonicalQuery}` : path,
        headers,
        timeout,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${method} ${key ?? path}: timeout`)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function withRetry(fn, what, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw new Error(`${what} failed after ${attempts} attempts: ${lastErr?.message ?? lastErr}`);
}

export async function putObject(key, body) {
  return withRetry(async () => {
    const res = await request('PUT', key, { body, timeout: 600_000 });
    if (res.status !== 200) throw new Error(`PUT ${key}: HTTP ${res.status} ${res.body.toString().slice(0, 300)}`);
    return { etag: res.headers.etag };
  }, `PUT ${key}`);
}

// Returns { size, etag } or null when the key does not exist.
export async function headObject(key) {
  return withRetry(async () => {
    const res = await request('HEAD', key);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`HEAD ${key}: HTTP ${res.status}`);
    return { size: Number(res.headers['content-length']), etag: res.headers.etag };
  }, `HEAD ${key}`);
}

export async function getObject(key) {
  return withRetry(async () => {
    const res = await request('GET', key, { timeout: 600_000 });
    if (res.status !== 200) throw new Error(`GET ${key}: HTTP ${res.status} ${res.body.toString().slice(0, 300)}`);
    return res.body;
  }, `GET ${key}`);
}

export async function deleteObject(key) {
  return withRetry(async () => {
    const res = await request('DELETE', key);
    if (res.status !== 204 && res.status !== 200) throw new Error(`DELETE ${key}: HTTP ${res.status}`);
  }, `DELETE ${key}`);
}

// ListObjectsV2 with prefix; returns [{ key, size }] across all pages.
export async function listObjects(prefix) {
  const out = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
    if (token) query['continuation-token'] = token;
    const res = await withRetry(async () => {
      const r = await request('GET', '', { query });
      if (r.status !== 200) throw new Error(`LIST ${prefix}: HTTP ${r.status} ${r.body.toString().slice(0, 300)}`);
      return r;
    }, `LIST ${prefix}`);
    const xml = res.body.toString();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = m[1].match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
      const size = Number(m[1].match(/<Size>(\d+)<\/Size>/)?.[1] ?? -1);
      if (key) out.push({ key: decodeXml(key), size });
    }
    token = xml.includes('<IsTruncated>true</IsTruncated>')
      ? (xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1] ?? null)
      : null;
  } while (token);
  return out;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// --- tiny CLI -----------------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'put') {
      const body = readFileSync(a);
      const { etag } = await putObject(b, body);
      console.log(`PUT ok: ${b} (${body.length} bytes, etag ${etag})`);
    } else if (cmd === 'head') {
      const info = await headObject(a);
      console.log(info ? `HEAD ok: ${a} size=${info.size} etag=${info.etag}` : `not found: ${a}`);
    } else if (cmd === 'get') {
      const body = await getObject(a);
      writeFileSync(b, body);
      console.log(`GET ok: ${a} -> ${b} (${body.length} bytes)`);
    } else if (cmd === 'list') {
      const items = await listObjects(a ?? '');
      for (const it of items) console.log(`${String(it.size).padStart(12)}  ${it.key}`);
      console.log(`(${items.length} objects)`);
    } else if (cmd === 'delete') {
      await deleteObject(a);
      console.log(`DELETE ok: ${a}`);
    } else {
      console.error('usage: s3.mjs put <file> <key> | head <key> | get <key> <out> | list <prefix> | delete <key>');
      process.exit(2);
    }
  } catch (e) {
    console.error(e.message ?? e);
    process.exit(1);
  }
}
