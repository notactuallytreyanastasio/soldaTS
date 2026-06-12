#!/usr/bin/env node
// tools/fetch-replays.mjs — restore offloaded replay blobs from the bucket.
//
// Counterpart to offload-replays.mjs: replays older than 24h live in Hetzner Object
// Storage under soldat/replays/<datasetDir>/. This pulls them back so trainers can
// re-consume any historical dataset.
//
// Usage:
//   node tools/fetch-replays.mjs <datasetDir> [<datasetDir>...]
//   node tools/fetch-replays.mjs 20260610-164950-VERONICA-matador-vs-AKELA-wolf
//
// Keys are discovered by listing the bucket prefix (works even if OFFLOADED.jsonl
// is gone). Downloads are size-verified; existing local files of the right size
// are skipped.

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getObject, listObjects } from './s3.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATASETS = join(ROOT, 'datasets');

const dirs = process.argv.slice(2).map((d) => basename(d.replace(/\/+$/, '')));
if (dirs.length === 0) {
  console.error('usage: node tools/fetch-replays.mjs <datasetDir> [<datasetDir>...]');
  process.exit(2);
}

let fetched = 0, skipped = 0, bytes = 0;
for (const dir of dirs) {
  const prefix = `soldat/replays/${dir}/`;
  const objects = await listObjects(prefix);
  if (objects.length === 0) {
    console.error(`no objects in bucket under ${prefix} — was this dataset ever offloaded?`);
    continue;
  }
  mkdirSync(join(DATASETS, dir), { recursive: true });
  for (const { key, size } of objects) {
    const local = join(DATASETS, dir, basename(key));
    if (existsSync(local) && statSync(local).size === size) {
      skipped++;
      continue;
    }
    const body = await getObject(key);
    if (body.length !== size) throw new Error(`size mismatch for ${key}: got ${body.length}, expected ${size}`);
    writeFileSync(local, body);
    fetched++;
    bytes += size;
    console.log(`  fetched ${basename(key)} (${size} bytes)`);
  }
  console.log(`${dir}: restored`);
}
console.log(`done: ${fetched} fetched (${(bytes / 1024 ** 2).toFixed(1)} MB), ${skipped} already local`);
