#!/usr/bin/env node
// tools/offload-replays.mjs — move replay blobs to Hetzner Object Storage, verified, then
// delete locally. The disk-rescue half of the corpus retention policy.
//
// Policy:
//   * Only `match-*.replay.jsonl.gz` files are touched. Manifests, summaries, events and
//     telemetry stay on disk FOREVER.
//   * Only datasets whose manifest createdAt is older than 24h (keep the last day local
//     for training). Fallback when manifest is missing/unparseable: directory mtime.
//   * Per file: upload -> HEAD verify size (+ MD5 etag when single-part) -> append
//     {localPath, s3Key, size, ts} to datasets/OFFLOADED.jsonl -> ONLY THEN unlink.
//     No deletion ever happens without a verified upload.
//   * Resumable: keys already in OFFLOADED.jsonl with matching size are not re-uploaded
//     (remote is still HEAD-verified before the local copy is removed).
//
// Usage:
//   node tools/offload-replays.mjs                 # the real thing
//   node tools/offload-replays.mjs --dry-run       # report what would move, touch nothing
//   node tools/offload-replays.mjs --limit 20      # cap files processed (smoke test)
//   OFFLOAD_CONCURRENCY=8                          # parallel uploads (default 8)
//
// Restore: node tools/fetch-replays.mjs <datasetDir>   (see MANUAL.md §5)

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { putObject, headObject, S3_BUCKET } from './s3.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS = join(ROOT, 'datasets');
const INDEX = join(DATASETS, 'OFFLOADED.jsonl');
const PREFIX = 'soldat/replays/';
const MAX_AGE_MS = 24 * 3600_000;
const CONCURRENCY = Math.max(1, Number(process.env.OFFLOAD_CONCURRENCY ?? 8));

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const limitIdx = argv.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : Infinity;

const gb = (bytes) => (bytes / 1024 ** 3).toFixed(2);

// --- 1. load the recovery index (resume support) ------------------------------------------

const indexed = new Map(); // s3Key -> size
if (existsSync(INDEX)) {
  for (const line of readFileSync(INDEX, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.s3Key && Number.isFinite(rec.size)) indexed.set(rec.s3Key, rec.size);
    } catch { /* tolerate torn lines from a previous crash */ }
  }
}

// --- 2. scan datasets, pick eligible replay files -----------------------------------------

function datasetCreatedAt(dir) {
  const manifest = join(DATASETS, dir, 'manifest.json');
  try {
    const t = Date.parse(JSON.parse(readFileSync(manifest, 'utf8')).createdAt);
    if (Number.isFinite(t)) return t;
  } catch { /* fall through */ }
  try {
    return statSync(join(DATASETS, dir)).mtimeMs;
  } catch {
    return Infinity; // unreadable -> treat as brand new, never offload blindly
  }
}

const now = Date.now();
const work = []; // { localPath, s3Key, size }
let skippedFresh = 0;

const dirs = readdirSync(DATASETS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

for (const dir of dirs) {
  if (now - datasetCreatedAt(dir) < MAX_AGE_MS) {
    skippedFresh++;
    continue;
  }
  let entries;
  try {
    entries = readdirSync(join(DATASETS, dir));
  } catch {
    continue;
  }
  for (const f of entries) {
    if (!/^match-\d+\.replay\.jsonl\.gz$/.test(f)) continue; // NEVER touch anything else
    const localPath = join(DATASETS, dir, f);
    let size;
    try {
      size = statSync(localPath).size;
    } catch {
      continue;
    }
    work.push({ localPath, s3Key: `${PREFIX}${dir}/${f}`, size });
  }
}

work.splice(Number.isFinite(LIMIT) ? LIMIT : work.length);
const totalBytes = work.reduce((a, w) => a + w.size, 0);
console.log(
  `offload: ${work.length} replay files (${gb(totalBytes)} GB) across ${dirs.length} dataset dirs ` +
  `(${skippedFresh} dirs <24h kept local)${DRY_RUN ? ' [DRY RUN]' : ''}`,
);
if (DRY_RUN || work.length === 0) {
  if (DRY_RUN) for (const w of work.slice(0, 10)) console.log(`  would move: ${relative(ROOT, w.localPath)}`);
  process.exit(0);
}

// --- 3. the pipeline: upload -> verify -> index -> delete ---------------------------------

let done = 0, uploaded = 0, resumed = 0, freedBytes = 0, movedBytes = 0;
const failures = [];

async function offloadOne({ localPath, s3Key, size }) {
  // Already uploaded in a previous run? Verify remote, then just delete local.
  if (indexed.get(s3Key) === size) {
    const head = await headObject(s3Key);
    if (head && head.size === size) {
      unlinkSync(localPath);
      resumed++;
      freedBytes += size;
      return;
    }
    // Index lied (object missing/mismatched) -> fall through and re-upload.
  }

  const body = readFileSync(localPath);
  if (body.length !== size) size = body.length; // file changed since scan; trust the bytes
  const md5 = createHash('md5').update(body).digest('hex');

  const { etag } = await putObject(s3Key, body);
  const head = await headObject(s3Key);
  if (!head || head.size !== size) {
    throw new Error(`verify failed for ${s3Key}: remote size ${head?.size} != local ${size}`);
  }
  const remoteMd5 = (head.etag ?? etag ?? '').replace(/"/g, '');
  if (/^[0-9a-f]{32}$/.test(remoteMd5) && remoteMd5 !== md5) {
    throw new Error(`verify failed for ${s3Key}: remote md5 ${remoteMd5} != local ${md5}`);
  }

  appendFileSync(
    INDEX,
    JSON.stringify({ localPath: relative(ROOT, localPath), s3Key, size, ts: new Date().toISOString() }) + '\n',
  );
  indexed.set(s3Key, size);
  unlinkSync(localPath); // ONLY after a verified upload + index append
  uploaded++;
  movedBytes += size;
  freedBytes += size;
}

async function worker(queue) {
  for (;;) {
    const item = queue.pop();
    if (!item) return;
    try {
      await offloadOne(item);
    } catch (e) {
      failures.push(`${item.s3Key}: ${e.message ?? e}`);
      if (failures.length >= 25) {
        throw new Error('too many failures (25) — aborting; nothing unverified was deleted');
      }
    }
    done++;
    if (done % 100 === 0) {
      console.log(
        `  [${done}/${work.length}] uploaded=${uploaded} resumed=${resumed} ` +
        `freed=${gb(freedBytes)}GB failures=${failures.length}`,
      );
    }
  }
}

const queue = [...work].reverse(); // pop() from the oldest first
const started = Date.now();
try {
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));
} catch (e) {
  console.error(`offload: ABORTED — ${e.message}`);
  for (const f of failures.slice(0, 10)) console.error(`  ${f}`);
  process.exit(1);
}

// --- 4. final report ------------------------------------------------------------------------

const mins = ((Date.now() - started) / 60_000).toFixed(1);
let remainBytes = 0;
for (const dir of dirs) {
  try {
    for (const f of readdirSync(join(DATASETS, dir))) {
      try { remainBytes += statSync(join(DATASETS, dir, f)).size; } catch { /* raced */ }
    }
  } catch { /* raced */ }
}

console.log('--- offload complete -----------------------------------------------------');
console.log(`files moved:      ${uploaded} uploaded + ${resumed} resumed-deletes = ${uploaded + resumed}`);
console.log(`GB uploaded:      ${gb(movedBytes)}`);
console.log(`GB freed locally: ${gb(freedBytes)}`);
console.log(`GB remaining in datasets/: ${gb(remainBytes)}`);
console.log(`bucket: ${S3_BUCKET}, prefix: ${PREFIX} | took ${mins} min`);
if (failures.length) {
  console.log(`FAILURES (${failures.length}) — these files were NOT deleted:`);
  for (const f of failures) console.log(`  ${f}`);
}
try {
  console.log(execSync('df -h /', { encoding: 'utf8' }).trimEnd());
} catch { /* cosmetic only */ }
process.exit(failures.length ? 1 : 0);
