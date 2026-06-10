#!/usr/bin/env node
// Match telemetry analyzer — turns a soldat-match-telemetry/1 dump into a
// readable gameplay report. Usage:
//   node tools/analyze-match.mjs <match.json[.gz]>
// Get a dump from a spectate session (?spectate): press T to download, or via
// CDP: JSON.stringify(window.__match.dump()). Dataset telemetry is gzipped
// (match-N.telemetry.json.gz) — both forms are accepted here.

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const path = process.argv[2];
if (!path) {
  console.error('usage: node tools/analyze-match.mjs <match.json[.gz]>');
  process.exit(1);
}
const buf = readFileSync(path);
const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
const m = JSON.parse(raw.toString('utf8'));
if (m.schema !== 'soldat-match-telemetry/1') {
  console.error(`unknown schema: ${m.schema}`);
  process.exit(1);
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const mins = m.durationTicks / 3600;
const d = m.derived;

console.log(`MATCH REPORT — ${m.meta.map} · ${m.meta.botCount} bots · ${mins.toFixed(1)} min (${m.durationTicks} ticks)`);
console.log(`schema ${m.schema} · ${m.samples.length} samples @ ${m.meta.sampleEveryTicks} ticks · ${m.kills.length} deaths (${d.killsPerMin.toFixed(1)}/min)\n`);

// Per-bot table.
const rows = Object.entries(d.perSprite)
  .map(([i, s]) => ({ i: Number(i), ...s }))
  .sort((a, b) => b.kills - a.kills);
console.log('PER BOT');
console.log('name      K   D   shots  hits  hitRate  jetUse  airTime  avgSpd  ySpread');
for (const r of rows) {
  console.log(
    `${r.name.padEnd(8)}${String(r.kills).padStart(3)}${String(r.deaths).padStart(4)}` +
      `${String(r.shots).padStart(8)}${String(r.hits).padStart(6)}` +
      `${pct(r.hitRate).padStart(9)}${pct(r.jetUsePct).padStart(8)}${pct(r.airTimePct).padStart(9)}` +
      `${r.avgSpeed.toFixed(2).padStart(8)}${r.ySpread.toFixed(0).padStart(9)}`,
  );
}

// Aggregates.
const tShots = rows.reduce((a, r) => a + r.shots, 0);
const tHits = rows.reduce((a, r) => a + r.hits, 0);
console.log(`\nAGGREGATE  shots ${tShots} · hits ${tHits} · hit rate ${pct(tShots ? tHits / tShots : 0)}`);
if (d.killDist) {
  console.log(`kill distance px: median ${d.killDist.median.toFixed(0)} (p25 ${d.killDist.p25.toFixed(0)}, p75 ${d.killDist.p75.toFixed(0)})`);
}
const unattributed = m.kills.filter((k) => k.dist === null).length;
if (unattributed > 0) console.log(`unattributed deaths: ${unattributed}`);

// Death clusters.
console.log('\nDEATH CLUSTERS (160px cells, biggest first)');
for (const c of d.deathClusters.slice(0, 8)) {
  console.log(`  (${c.x.toFixed(0).padStart(6)}, ${c.y.toFixed(0).padStart(6)})  x${c.count}`);
}

// Flight math: altitude + jet timeline in 30s buckets.
console.log('\nFLIGHT (per 30s bucket: mean altitude(y), % airborne, % jetting over live samples)');
const bucket = new Map();
for (const s of m.samples) {
  const b = Math.floor(s.tick / 1800);
  const acc = bucket.get(b) ?? { n: 0, y: 0, air: 0, jet: 0 };
  for (const sp of s.sprites) {
    acc.n += 1;
    acc.y += sp.y;
    acc.air += sp.air ? 1 : 0;
    acc.jet += sp.jetting ? 1 : 0;
  }
  bucket.set(b, acc);
}
for (const [b, a] of [...bucket.entries()].sort((x, y) => x[0] - y[0])) {
  if (a.n === 0) continue;
  console.log(
    `  ${String(b * 30).padStart(4)}s  y=${(a.y / a.n).toFixed(0).padStart(6)}  air ${pct(a.air / a.n).padStart(6)}  jet ${pct(a.jet / a.n).padStart(6)}`,
  );
}
