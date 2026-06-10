#!/usr/bin/env node
// Headless-Chrome CDP screenshot tool for the soldat-ts client.
//
// Why CDP and not `chrome --screenshot --virtual-time-budget`: the game boots
// asynchronously (PixiJS init, async asset fetches, RAF loop) and virtual time
// expires before the first real frame, producing a black capture. Driving
// Chrome over the DevTools protocol lets us wait REAL seconds while the match
// actually plays, then grab the canvas mid-action.
//
// Usage:
//   node tools/screenshot.mjs <url> <outfile.png> [settleSeconds=8] [width=1280] [height=800] [zoomSteps=0]
//
// zoomSteps > 0 dispatches that many wheel-up events at the canvas centre after
// settling (the client zooms at the cursor), waits 2s for the camera to settle,
// then captures — for close-up action shots.
//
// Requires Node >= 22 (global WebSocket + fetch). Spawns its own Chrome with a
// throwaway profile; kills it on exit.

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_BIN ??
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const [url, outFile, settleArg, wArg, hArg, zoomArg, holdKeysArg] = process.argv.slice(2);
if (!url || !outFile) {
  console.error(
    'usage: screenshot.mjs <url> <outfile.png> [settleSeconds] [w] [h] [zoomSteps] [holdKeys]',
  );
  console.error('  holdKeys: comma-separated KeyboardEvent codes (e.g. "Space,KeyD")');
  console.error('  held down (no keyup) 3s before capture — lets the player act in the shot');
  process.exit(1);
}
const settleMs = (Number(settleArg) || 8) * 1000;
const width = Number(wArg) || 1280;
const height = Number(hArg) || 800;
const zoomSteps = Number(zoomArg) || 0;
const holdKeys = holdKeysArg ? holdKeysArg.split(',').filter(Boolean) : [];
const port = 9222 + Math.floor(Math.random() * 500);

const profile = mkdtempSync(join(tmpdir(), 'soldat-shot-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--mute-audio',
    'about:blank',
  ],
  { stdio: 'ignore' },
);
const cleanup = () => {
  try { chrome.kill('SIGKILL'); } catch { /* gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* busy */ }
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for the DevTools endpoint, then open the page as a fresh target.
async function waitForChrome() {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome DevTools endpoint never came up');
}

async function openTarget() {
  const res = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: 'PUT' },
  );
  if (!res.ok) throw new Error(`/json/new failed: ${res.status}`);
  return res.json();
}

// Minimal CDP client over the global WebSocket.
function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('CDP socket error')), { once: true });
  });
  return { send, ready, close: () => ws.close() };
}

try {
  await waitForChrome();
  const target = await openTarget();
  const client = cdp(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send('Page.enable');
  await client.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 2, mobile: false,
  });
  // Let the game boot, load assets, and the match develop.
  await sleep(settleMs);
  // Hold keys (keydown only — the game treats a held key as continuous input,
  // e.g. Space = full-auto fire) so single-player historical shots have action.
  // The special token "MouseFire" holds the left button down up-and-right of
  // centre instead — pre-keyboard-controls builds fire on mouse only.
  for (const code of holdKeys) {
    if (code === 'MouseFire') {
      await client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: width * 0.62, y: height * 0.4,
      });
      await client.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: width * 0.62, y: height * 0.4,
        button: 'left', buttons: 1, clickCount: 1,
      });
      continue;
    }
    await client.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      code,
      key: code === 'Space' ? ' ' : code.replace(/^Key/, '').toLowerCase(),
      windowsVirtualKeyCode: code === 'Space' ? 32 : code.charCodeAt(code.length - 1),
    });
  }
  if (holdKeys.length > 0) await sleep(3000);
  for (let z = 0; z < zoomSteps; z++) {
    await client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: width / 2,
      y: height / 2,
      deltaX: 0,
      deltaY: -120,
    });
    await sleep(60);
  }
  if (zoomSteps > 0) await sleep(2000);
  const shot = await client.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
  console.log(`captured ${outFile} (${url}, settled ${settleMs / 1000}s)`);
  client.close();
  process.exit(0);
} catch (err) {
  console.error('screenshot failed:', err.message);
  process.exit(1);
}
