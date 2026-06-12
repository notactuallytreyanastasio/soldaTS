// SOLDAT, REWRITTEN, landing interactions (goal node 533).
// Vanilla everything: a canvas dogfight behind the hero, scroll-reveals,
// animated counters, and the roster cards. No frameworks, no fetches.

// ---------------------------------------------------------------------------
// The roster. Doctrine text condensed from each brain's source header.
// ---------------------------------------------------------------------------
const ROSTER = [
  { n: 'CLASSIC', t: 'doctrine', one: 'The ported Pascal brain. The baseline everyone is measured against.',
    lore: 'Perception, distance-band combat, waypoint navigation, extracted line-by-line from the 2002 engine. It has slaughtered smarter brains that trained badly.' },
  { n: 'PILOT', t: 'doctrine', one: 'A Counter-Strike pro, rotated into 2D-plus-vertical.',
    lore: 'Positioning beats aim: hold the height edge, keep duels in the 200–420px band, strafe-juke on an RNG clock to defeat constant-velocity prediction, reload on your own terms. The first authored doctrine, and the first belt holder.' },
  { n: 'REAPER', t: 'doctrine', one: 'The dive brawler built to deny pilot its range band.',
    lore: 'Relentless gap-close from above, knife-range commitment. v1 went 0–4; a telemetry pass made v2 contest it. The first lesson in counter-design: doctrine beats aspiration.' },
  { n: 'MATADOR', t: 'doctrine', one: 'The magazine is a clock. Punish whoever ignores it.',
    lore: 'Refuses the duel while the enemy gun is hot, stalks as the mag drains, dashes exactly at the reload. The first brain to weaponize tempo instead of aim.' },
  { n: 'KESTREL', t: 'doctrine', one: 'The marksman who audited the bullets themselves.',
    lore: 'Did archaeology on the fire model and found every prior brain compensated for the wrong bullet gravity, 2.25× off. Plant to shoot, dodge vertically, read the real arc. First brain to clear a 46% hit rate.' },
  { n: 'WOLF', t: 'doctrine', one: 'ONE PREY. Three guns converge on the weakest body.',
    lore: 'Pack-shared focus: the lowest-health enemy visible to any packmate becomes everyone’s target, with crossfire bearings so the kill is arithmetic, not aim. Proved the team is the unit of selection.' },
  { n: 'PLOVER', t: 'doctrine', one: 'The broken-wing gambit. Feed the pack a decoy.',
    lore: 'Read wolf’s deterministic prey function and fed it bait, one bird dangles wounded, the executioners mirror wolf’s own focus arithmetic back at it. Took its opener 38–37. Second-order strategy: it fights the other brain’s mind.' },
  { n: 'HYDRA', t: 'doctrine', one: 'Cut one head, the others bite.',
    lore: 'The anchor rotation: any head that bleeds withdraws from the pack’s shared focus, fresh heads bite with kestrel gunnery. Independently derived the same counter as plover, convergent evolution, in a git repo.' },
  { n: 'SHRIKE', t: 'doctrine', one: 'The first weapon-aware brain. The shotgun finally has a doctrine.',
    lore: 'Breacher role on the SPAS wildcard: silent approach, gravity dive, a six-shell fan released only inside the kill envelope (79.7% hit rate on the role). Overwatch partner on the AK. Its early failure exposed a shared-focus targeting bug, the shotgun paradox.' },
  { n: 'CUADRILLA', t: 'doctrine', one: 'The bullfighter’s crew. Three proven lessons, one doctrine.',
    lore: 'Matador’s mag-punish + wolf’s pack focus + hydra’s reserve rotation. Swept the field 9–0 on arrival and reigned for seasons as BELMONTE. Also: the teacher every learned student trains on.' },
  { n: 'ORCA', t: 'doctrine', one: 'The pod hunts the gap in the enemy’s reload clock.', champ: true,
    lore: 'Synchronizes the wave not on health but on the moment the enemy is disarmed; ebbs to poke range while guns are hot; the wounded member swims deep. As BLACKFISH, the reigning champion, three straight seasons and counting.' },
  { n: 'ANGLER', t: 'doctrine', one: 'The lure that fishes the meta itself.',
    lore: 'One crew member dangles at the held-mag floor so every mag-reading selector in the league reads “open” forever, and the gallery converges on whoever takes the bait. Held the belt as ESCA in season 4.' },
  { n: 'MIMIC', t: 'learned', one: 'Eleven teachers, averaged into mush.', gen: 'student v1',
    lore: 'Behavior-cloned from all the written doctrines at once. Contradictory teachers average into nothing; regression aim blurred multimodal targets into a 38° error. Slaughtered 4–28 by classic. The essential failure the rest of the line is built on.' },
  { n: 'DISCIPLE', t: 'learned', one: 'One master. Aim as a choice, not an average.', gen: 'student v2',
    lore: 'Cloned cuadrilla alone, with the aim head rebuilt as 24-way classification, softmax keeps multimodal aim multimodal and picks the strongest mode. Tripled MIMIC’s hit rate. Lost 0–3 to its master, which is the correct result.' },
  { n: 'PRODIGY', t: 'learned', one: 'Grew real senses. Trained on data that lied to it.', gen: 'student v3',
    lore: 'Sees reload flags, mag state, the nearest bullet threat, and keeps one tick of memory. But its threat sense was trained on reconstructed data that didn’t match the live computation, its own post-mortem prescribed the cure.' },
  { n: 'BUTTSTEIN', t: 'learned', one: 'Trained on exact data. Tripled its ancestor’s hit rate.', gen: 'student v4',
    lore: 'Replay schema v2 logs the exact threat the runtime computes, so recorder and brain cannot disagree. Observes its own spray heat, trigger discipline became a learned response. Landed shots carry 5× gradient. 17.4% hit rate vs prodigy’s 5.4%.' },
];

const grid = document.getElementById('rosterGrid');
for (const b of ROSTER) {
  const el = document.createElement('div');
  el.className = 'brain' + (b.champ ? ' champ' : '');
  el.innerHTML =
    `<div class="bhead"><b>${b.n}</b><span class="tag ${b.t}">${b.t === 'learned' ? (b.gen || 'LEARNED') : 'DOCTRINE'}</span></div>` +
    `<div class="one">${b.one}</div>` +
    `<div class="lore">${b.lore}</div>`;
  el.addEventListener('click', () => el.classList.toggle('open'));
  grid.appendChild(el);
}

// ---------------------------------------------------------------------------
// Scroll reveals + counters + scrollspy
// ---------------------------------------------------------------------------
const seen = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (e.isIntersecting) { e.target.classList.add('seen'); seen.unobserve(e.target); }
  }
}, { threshold: 0.18 });
document.querySelectorAll('.act, .student, .belt-line li, .wreck').forEach((el) => seen.observe(el));

const counters = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    counters.unobserve(e.target);
    const target = Number(e.target.dataset.count);
    const t0 = performance.now();
    const dur = 1400;
    const tick = (t) => {
      const p = Math.min((t - t0) / dur, 1);
      const eased = 1 - Math.pow(1 - p, 3);
      e.target.textContent = Math.round(target * eased).toLocaleString('en-US');
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}, { threshold: 0.6 });
document.querySelectorAll('[data-count]').forEach((el) => counters.observe(el));

const navLinks = [...document.querySelectorAll('#topnav .links a')];
const spy = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const id = '#' + e.target.id;
    navLinks.forEach((a) => a.classList.toggle('active', a.getAttribute('href') === id));
  }
}, { rootMargin: '-40% 0px -55% 0px' });
document.querySelectorAll('main section, #tale').forEach((s) => spy.observe(s));

// ---------------------------------------------------------------------------
// The sky: a tiny ambient dogfight. Six dots with jet physics chase each
// other and trade tracers. It is not the real sim, it is set dressing that
// knows what the real thing looks like.
// ---------------------------------------------------------------------------
const cv = document.getElementById('sky');
const cx = cv.getContext('2d');
let W = 0, H = 0;
const resize = () => { W = cv.width = innerWidth * devicePixelRatio; H = cv.height = innerHeight * devicePixelRatio; };
addEventListener('resize', resize);
resize();

const TEAM = ['#ff5d5d', '#5da9ff'];
const rand = (a, b) => a + Math.random() * (b - a);
const fighters = Array.from({ length: 6 }, (_, i) => ({
  x: rand(0.1, 0.9) * W, y: rand(0.15, 0.7) * H,
  vx: rand(-1, 1), vy: 0, team: i % 2,
  jet: 0, fire: 0, target: (i + 1) % 6,
}));
const tracers = [];
const trails = [];

function step() {
  cx.clearRect(0, 0, W, H);
  const g = 0.045 * devicePixelRatio;

  for (const f of fighters) {
    const t = fighters[f.target];
    // retarget occasionally, prefer the other team
    if (Math.random() < 0.004) {
      const foes = fighters.filter((o) => o.team !== f.team);
      f.target = fighters.indexOf(foes[(Math.random() * foes.length) | 0]);
    }
    // jets: chase height advantage, like the aerial doctrine says
    f.jet = (t && f.y > t.y - 40 * devicePixelRatio) || f.y > H * 0.75 ? f.jet + 1 : 0;
    f.vy += g;
    if (f.jet > 0) f.vy -= g * 1.9;
    if (f.y < H * 0.12) f.vy += g * 1.5;
    f.vx += Math.sign((t ? t.x : W / 2) - f.x) * 0.012 * devicePixelRatio;
    f.vx = Math.max(-1.6, Math.min(1.6, f.vx)) * 0.998;
    f.vy = Math.max(-1.4, Math.min(1.8, f.vy));
    f.x += f.vx * devicePixelRatio; f.y += f.vy * devicePixelRatio;
    if (f.x < 0) { f.x = 0; f.vx = Math.abs(f.vx); }
    if (f.x > W) { f.x = W; f.vx = -Math.abs(f.vx); }
    if (f.y > H * 0.92) { f.y = H * 0.92; f.vy = -0.2; }

    if (f.jet > 0 && Math.random() < 0.6) {
      trails.push({ x: f.x, y: f.y + 4 * devicePixelRatio, a: 0.5 });
    }
    // tracers at the target when roughly in band
    f.fire -= 1;
    if (t && f.fire <= 0 && Math.random() < 0.02) {
      f.fire = 26;
      const dx = t.x - f.x, dy = t.y - f.y;
      const d = Math.hypot(dx, dy) || 1;
      const spread = rand(-0.09, 0.09);
      const ca = Math.cos(spread), sa = Math.sin(spread);
      const ux = (dx / d) * ca - (dy / d) * sa, uy = (dx / d) * sa + (dy / d) * ca;
      for (let k = 0; k < 3; k++) {
        tracers.push({ x: f.x + ux * k * 9, y: f.y + uy * k * 9, vx: ux * 7 * devicePixelRatio, vy: uy * 7 * devicePixelRatio, a: 1, team: f.team });
      }
    }
  }

  for (let i = trails.length - 1; i >= 0; i--) {
    const p = trails[i];
    p.a -= 0.02; p.y += 0.6 * devicePixelRatio;
    if (p.a <= 0) { trails.splice(i, 1); continue; }
    cx.fillStyle = `rgba(245,197,66,${p.a * 0.5})`;
    cx.fillRect(p.x, p.y, 2 * devicePixelRatio, 2 * devicePixelRatio);
  }

  for (let i = tracers.length - 1; i >= 0; i--) {
    const b = tracers[i];
    b.x += b.vx; b.y += b.vy; b.vy += g * 0.5; b.a -= 0.012;
    if (b.a <= 0 || b.x < 0 || b.x > W || b.y > H) { tracers.splice(i, 1); continue; }
    cx.strokeStyle = `rgba(232,228,218,${b.a * 0.8})`;
    cx.lineWidth = devicePixelRatio;
    cx.beginPath();
    cx.moveTo(b.x, b.y);
    cx.lineTo(b.x - b.vx * 1.6, b.y - b.vy * 1.6);
    cx.stroke();
  }

  for (const f of fighters) {
    cx.fillStyle = TEAM[f.team];
    cx.beginPath();
    cx.arc(f.x, f.y, 3.2 * devicePixelRatio, 0, Math.PI * 2);
    cx.fill();
  }

  requestAnimationFrame(step);
}
// Respect prefers-reduced-motion: render one static frame instead of animating.
if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  step.toString(); // no-op; leave the canvas empty
} else {
  requestAnimationFrame(step);
}
