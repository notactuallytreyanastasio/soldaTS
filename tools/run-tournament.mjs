#!/usr/bin/env node
// Tournament runner — fires up 4 simultaneous mixed-AI team games headlessly,
// waits, then prints the standings: per-engine dominance, the crowned engine,
// top fighters, and the next-round command (same whole teams, fresh seeds).
//
// Usage (dev server must be running: pnpm play):
//   node tools/run-tournament.mjs [secondsOr'round'] [roster=classic,pilot] [url=http://localhost:5173] [roundSecs=600]
//
// Numeric first arg = fixed-duration watch (legacy behavior, URL unchanged).
// 'round' = timed-round mode: every game runs a roundSecs timed round; the
// script polls window.__tournament.round() until all 4 games report round
// over (generous timeout), then prints the standings + the round winner.
//   node tools/run-tournament.mjs round classic,pilot http://localhost:5173 20
//
// The next-round line can be fed straight back in for round 2:
//   node tools/run-tournament.mjs 120 pilot,pilot,pilot,pilot,classic,classic

import { spawn } from 'node:child_process';

const roundMode = process.argv[2] === 'round';
const seconds = roundMode ? 0 : Number(process.argv[2] ?? 120);
const roster = process.argv[3] ?? 'classic,pilot';
const base = process.argv[4] ?? 'http://localhost:5173';
const roundSecs = Number(process.argv[5] ?? 600);
const chrome =
  process.env.CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// &round= is passed ONLY in round mode — numeric mode keeps the legacy URL.
const url =
  `${base}/?tournament&ai=${encodeURIComponent(roster)}` +
  (roundMode ? `&round=${roundSecs}` : '');
const proc = spawn(
  chrome,
  ['--headless=new', '--remote-debugging-port=9233', '--window-size=1920,1080', '--no-first-run', 'about:blank'],
  { stdio: 'ignore' },
);
await new Promise((r) => setTimeout(r, 2000));

const targets = await (await fetch('http://localhost:9233/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    pending.get(d.id)(d.result);
    pending.delete(d.id);
  }
};
await new Promise((r) => (ws.onopen = r));
await send('Page.enable');
await send('Page.navigate', { url });
console.log(`tournament running: ${url}`);

let round = { done: false, gamesOver: 0, champion: '' };
if (roundMode) {
  // Wait for the ROUND END: poll until every game reports a verdict. The
  // deadline is generous — sim time tracks wall time roughly 1:1, plus boot
  // and slow-tile grace.
  console.log(`waiting for all 4 games to finish their ${roundSecs}s rounds...`);
  const deadline = Date.now() + (roundSecs + 180) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const res = await send('Runtime.evaluate', {
      expression:
        'JSON.stringify(window.__tournament && window.__tournament.round ? window.__tournament.round() : null)',
      returnByValue: true,
    });
    const parsed = res?.result?.value ? JSON.parse(res.result.value) : null;
    if (parsed) {
      round = parsed;
      console.log(`round: ${round.gamesOver}/4 games over`);
    }
    if (round.done) break;
  }
  if (!round.done) console.log('TIMEOUT waiting for round end — printing partial standings');
} else {
  console.log(`watching ${seconds}s (4 games in parallel)...`);
  await new Promise((r) => setTimeout(r, seconds * 1000));
}

const res = await send('Runtime.evaluate', {
  expression: 'window.__tournament.report()',
  returnByValue: true,
});
console.log('\n' + res.result.value + '\n');
if (round.done) console.log(`ROUND WINNER: ${round.champion}\n`);
const next = await send('Runtime.evaluate', {
  expression: 'window.__tournament.nextRoundUrl()',
  returnByValue: true,
});
const nextUrl = new URL(next.result.value, base);
console.log(`next round (same teams, fresh seeds): ${base}${nextUrl.pathname}${nextUrl.search}`);
proc.kill();
process.exit(0);
