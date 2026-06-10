#!/usr/bin/env node
// Tournament runner — fires up 4 simultaneous mixed-AI team games headlessly,
// waits, then prints the standings: per-engine dominance, the crowned engine,
// top fighters, and the evolved next-round roster ("model more after them").
//
// Usage (dev server must be running: pnpm play):
//   node tools/run-tournament.mjs [seconds=120] [roster=classic,pilot] [url=http://localhost:5173]
//
// The evolved roster line can be fed straight back in for round 2:
//   node tools/run-tournament.mjs 120 pilot,pilot,pilot,pilot,classic,classic

import { spawn } from 'node:child_process';

const seconds = Number(process.argv[2] ?? 120);
const roster = process.argv[3] ?? 'classic,pilot';
const base = process.argv[4] ?? 'http://localhost:5173';
const chrome =
  process.env.CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const url = `${base}/?tournament&ai=${encodeURIComponent(roster)}`;
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
console.log(`watching ${seconds}s (4 games in parallel)...`);
await new Promise((r) => setTimeout(r, seconds * 1000));

const res = await send('Runtime.evaluate', {
  expression: 'window.__tournament.report()',
  returnByValue: true,
});
console.log('\n' + res.result.value + '\n');
const next = await send('Runtime.evaluate', {
  expression: 'window.__tournament.nextRosterUrl()',
  returnByValue: true,
});
const evolved = new URL(next.result.value, base).searchParams.get('ai');
console.log(`re-run evolved round: node tools/run-tournament.mjs ${seconds} ${evolved}`);
proc.kill();
process.exit(0);
