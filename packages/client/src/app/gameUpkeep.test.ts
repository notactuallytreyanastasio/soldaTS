// Game per-tick upkeep — the client-owned weapon/respawn machinery that the
// sim spine leaves out: fire cadence (nextFireTick), magazine + reload
// timing, the empty-mag auto-reload, spray-heat bloom/decay, the weapon-swap
// ring (rising edge, per-slot ammo, reload cancel), the Barrett charge-up,
// death/respawn upkeep (timers, tallies, fresh loadout, spawn-point pick),
// jet refuel, and human team assignment. All headless: botCount 0, the test
// drives the player sprite's control directly, hooks (onShot/onSound/onKill)
// record what happened.

import { describe, it, expect } from 'vitest';
import { getGun, WeaponIndex } from '@soldat/sim';
import { Game, DEFAULT_TUNING, type GameTuning } from './game';

const TICK_DT = 1 / 60;
const P = 1; // Game.playerIndex

interface Hooks {
  shots: number[];
  sounds: { event: string; x: number; y: number }[];
  kills: { killer: number; victim: number }[];
}

function soloGame(
  tuning?: Partial<GameTuning>,
  opts: { spawns?: { x: number; y: number }[] } = {},
): { g: Game; h: Hooks } {
  const g = new Game({
    seed: 11,
    botCount: 0,
    ...(tuning !== undefined ? { tuning } : {}),
    ...(opts.spawns !== undefined ? { spawns: opts.spawns } : {}),
  });
  const h: Hooks = { shots: [], sounds: [], kills: [] };
  g.onShot = (shooter) => h.shots.push(shooter);
  g.onSound = (event, x, y) => h.sounds.push({ event, x, y });
  g.onKill = (killer, victim) => h.kills.push({ killer, victim });
  return { g, h };
}

const player = (g: Game) => g.world.sprites[P]!;
const run = (g: Game, n: number): void => {
  for (let i = 0; i < n; i++) g.tick(TICK_DT);
};
/** One rising edge of changeWeapon: held for one tick, released for one. */
const swapPulse = (g: Game): void => {
  player(g).control.changeWeapon = true;
  g.tick(TICK_DT);
  player(g).control.changeWeapon = false;
  g.tick(TICK_DT);
};

describe('fire cadence', () => {
  it('enforces fireInterval between shots (default 6 ticks)', () => {
    const { g, h } = soloGame();
    player(g).control.fire = true;
    run(g, 12); // clocks 0..11 → shots at 0 and 6
    expect(h.shots).toHaveLength(2);
    expect(g.playerAmmo()).toBe(DEFAULT_TUNING.magSize - 2);
    run(g, 1); // clock 12 → third shot
    expect(h.shots).toHaveLength(3);
  });

  it('one trigger pull = one round of ammo and one fire sound', () => {
    const { g, h } = soloGame();
    player(g).control.fire = true;
    run(g, 1);
    expect(h.shots).toEqual([P]);
    expect(g.playerAmmo()).toBe(DEFAULT_TUNING.magSize - 1);
    expect(h.sounds.filter((s) => s.event === 'fire')).toHaveLength(1);
  });
});

describe('spray heat', () => {
  it('accumulates spreadHeatPerShot per shot', () => {
    const { g } = soloGame({ fireInterval: 1 });
    player(g).control.fire = true;
    run(g, 5);
    expect(g.sprayHeatOf(P)).toBeCloseTo(5 * DEFAULT_TUNING.spreadHeatPerShot, 10);
  });

  it('caps at the global heat maximum (0.16)', () => {
    const { g } = soloGame({ fireInterval: 1 });
    player(g).control.fire = true;
    run(g, 30); // 30 shots * 0.012 = 0.36 uncapped
    expect(g.sprayHeatOf(P)).toBeCloseTo(0.16, 10);
  });

  it('decays by 0.05/tick when not firing, clamped at zero', () => {
    const { g } = soloGame({ fireInterval: 1 });
    player(g).control.fire = true;
    run(g, 6); // heat 0.072
    player(g).control.fire = false;
    run(g, 1);
    expect(g.sprayHeatOf(P)).toBeCloseTo(0.022, 10);
    run(g, 1);
    expect(g.sprayHeatOf(P)).toBe(0);
    run(g, 3);
    expect(g.sprayHeatOf(P)).toBe(0); // never goes negative
  });
});

describe('reload', () => {
  it('manual reload refills exactly at reloadUntil and the gun fires next tick', () => {
    const { g, h } = soloGame({ magSize: 3, reloadTicks: 10 });
    player(g).control.fire = true;
    run(g, 1); // one shot → ammo 2
    player(g).control.fire = false;
    expect(g.playerAmmo()).toBe(2);

    player(g).control.reload = true;
    g.tick(TICK_DT); // reload starts at clock 1 → completes at clock 11
    player(g).control.reload = false;
    expect(g.playerReloading()).toBe(true);
    expect(h.sounds.filter((s) => s.event === 'reloadStart')).toHaveLength(1);

    run(g, 8); // clocks 2..9 — still reloading, ammo untouched
    expect(g.playerReloading()).toBe(true);
    expect(g.playerAmmo()).toBe(2);

    run(g, 1); // clock 10 === reloadUntil - 1 → the refill tick
    expect(g.playerAmmo()).toBe(3);
    expect(g.playerReloading()).toBe(false);

    player(g).control.fire = true;
    run(g, 1); // clock 11 — ready to fire immediately
    expect(h.shots).toHaveLength(2);
  });

  it('manual reload is a no-op on a full magazine', () => {
    const { g, h } = soloGame();
    player(g).control.reload = true;
    run(g, 5);
    expect(g.playerReloading()).toBe(false);
    expect(h.sounds.filter((s) => s.event === 'reloadStart')).toHaveLength(0);
  });

  it('an empty magazine auto-reloads under held fire without consuming ammo', () => {
    const { g, h } = soloGame({ magSize: 2, fireInterval: 1, reloadTicks: 10 });
    player(g).control.fire = true;
    run(g, 3); // shots at clocks 0,1; clock 2 finds the mag empty → reload
    expect(h.shots).toHaveLength(2);
    expect(g.playerAmmo()).toBe(0);
    expect(g.playerReloading()).toBe(true);
    expect(h.sounds.filter((s) => s.event === 'reloadStart')).toHaveLength(1);

    run(g, 9); // clocks 3..11 — refill lands at clock 11 (reloadUntil-1)
    expect(g.playerAmmo()).toBe(2);
    expect(g.playerReloading()).toBe(false);
    expect(h.shots).toHaveLength(2); // nothing fired mid-reload

    run(g, 1); // clock 12 — resumes firing
    expect(h.shots).toHaveLength(3);
    expect(g.playerAmmo()).toBe(1);
  });
});

describe('weapon swap', () => {
  it('cycles the six-slot ring back to the AK', () => {
    const { g } = soloGame();
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      swapPulse(g);
      seen.push(g.weaponNameOf(P));
    }
    expect(seen).toEqual(['SPAS12', 'BARRETT', 'ROCKET', 'RICOCHET', 'CHAINSAW', 'AK74']);
  });

  it('only the RISING edge swaps — holding the key is one swap', () => {
    const { g } = soloGame();
    player(g).control.changeWeapon = true;
    run(g, 5);
    expect(g.weaponNameOf(P)).toBe('SPAS12');
  });

  it('each slot keeps its own ammo across swaps', () => {
    const { g } = soloGame();
    player(g).control.fire = true;
    run(g, 1); // AK ammo 30 → 29
    player(g).control.fire = false;
    swapPulse(g);
    // SPAS magazine at stock tuning: round(7 * 30/35) = 6.
    expect(g.weaponNameOf(P)).toBe('SPAS12');
    expect(g.ammoOf(P)).toBe(6);
    for (let i = 0; i < 5; i++) swapPulse(g); // ring back to the AK
    expect(g.weaponNameOf(P)).toBe('AK74');
    expect(g.ammoOf(P)).toBe(29); // no free reload
  });

  it('swapping away mid-reload CANCELS the reload', () => {
    const { g } = soloGame(); // reloadTicks 95 — far longer than the 14 ticks below
    player(g).control.fire = true;
    run(g, 1);
    player(g).control.fire = false;
    player(g).control.reload = true;
    g.tick(TICK_DT);
    player(g).control.reload = false;
    expect(g.playerReloading()).toBe(true);

    for (let i = 0; i < 6; i++) swapPulse(g); // full ring back to the AK (12 ticks)
    expect(g.weaponNameOf(P)).toBe('AK74');
    // 14 ticks elapsed, the 95-tick reload would still be running — but the
    // first swap zeroed it, so the AK is idle and STILL down a round.
    expect(g.playerReloading()).toBe(false);
    expect(g.playerAmmo()).toBe(DEFAULT_TUNING.magSize - 1);
  });
});

describe('Barrett charge-up', () => {
  const startUp = getGun(WeaponIndex.BARRETT, false).startUpTime; // 19

  it('a ready trigger pull must be HELD startUpTime ticks before firing', () => {
    const { g, h } = soloGame();
    swapPulse(g);
    swapPulse(g);
    expect(g.weaponNameOf(P)).toBe('BARRETT');
    player(g).control.fire = true;
    run(g, startUp); // 19 ticks of charging — no round leaves the barrel
    expect(h.shots).toHaveLength(0);
    run(g, 1); // the 20th tick fires
    expect(h.shots).toHaveLength(1);
    expect(g.ammoOf(P)).toBe(2); // stock Barrett mag 3, one spent
  });

  it('releasing fire mid-charge cancels — a fresh pull starts from zero', () => {
    const { g, h } = soloGame();
    swapPulse(g);
    swapPulse(g);
    player(g).control.fire = true;
    run(g, 10); // partial charge
    player(g).control.fire = false;
    run(g, 1); // release: charge reset
    player(g).control.fire = true;
    run(g, startUp); // a FULL new charge is required
    expect(h.shots).toHaveLength(0);
    run(g, 1);
    expect(h.shots).toHaveLength(1);
  });
});

describe('death and respawn', () => {
  const SPAWNS = [
    { x: 0, y: 0 },
    { x: 1000, y: 0 },
    { x: 2000, y: 0 },
  ];

  it('the death edge arms the timer, tallies, attributes, and freezes control', () => {
    const { g, h } = soloGame({ respawnTicks: 5 });
    player(g).control.fire = true;
    player(g).lastHitBy = 2;
    player(g).health = 0;
    run(g, 1); // the edge tick
    expect(player(g).deadMeat).toBe(true);
    expect(h.kills).toEqual([{ killer: 2, victim: P }]);
    expect(g.deathsOf(P)).toBe(1);
    expect(g.killsOf(2)).toBe(1);
    expect(h.sounds.filter((s) => s.event === 'death')).toHaveLength(1);
    expect(player(g).control.fire).toBe(false); // frozen while dead
  });

  it('counts down exactly respawnTicks before respawning', () => {
    const { g } = soloGame({ respawnTicks: 5 });
    player(g).health = 0;
    run(g, 1); // edge
    run(g, 4); // 4 of the 5 countdown ticks
    expect(player(g).deadMeat).toBe(true);
    run(g, 1); // the 5th — respawn
    expect(player(g).deadMeat).toBe(false);
    expect(player(g).health).toBe(150);
  });

  it('a dead sprite cannot fire even if fire is forced back on', () => {
    const { g, h } = soloGame({ respawnTicks: 5 });
    player(g).health = 0;
    run(g, 1);
    player(g).control.fire = true; // un-freeze it by hand
    run(g, 3);
    expect(h.shots).toHaveLength(0);
  });

  it('respawning grants a fresh loadout: full ammo, zero heat, full fuel', () => {
    const { g } = soloGame({ respawnTicks: 5, fireInterval: 1 });
    const p = player(g);
    p.control.fire = true;
    run(g, 5); // burn 5 rounds + build heat
    p.control.fire = false;
    p.jetsCount = 17;
    p.lastHitBy = 2;
    p.health = 0;
    run(g, 6); // edge + 5-tick countdown → respawn
    expect(player(g).deadMeat).toBe(false);
    expect(g.playerAmmo()).toBe(DEFAULT_TUNING.magSize);
    expect(g.sprayHeatOf(P)).toBe(0);
    expect(player(g).jetsCount).toBe(DEFAULT_TUNING.jetFuelMax);
    expect(player(g).lastHitBy).toBe(0); // stale attribution cleared
  });

  it('respawn picks spawnFor(index + tick) — NOT the initial spawn', () => {
    // SUSPECT (review finding): initial spawns use sequential indices
    // (spawnFor(h) for humans), but respawns use spawnFor(index +
    // mainTickCounter), so where you come back depends on WHEN you died.
    // Asserting the actual formula here.
    const { g } = soloGame({ respawnTicks: 5 }, { spawns: SPAWNS });
    const parts = g.world.spriteParts!;
    expect(parts.posX[P]).toBeCloseTo(SPAWNS[0]!.x); // initial: spawnFor(0)

    run(g, 3);
    player(g).health = 0;
    run(g, 6); // edge + countdown → respawn during the last tick
    expect(player(g).deadMeat).toBe(false);
    const tick = g.world.mainTickCounter;
    const expected = SPAWNS[(P + tick) % SPAWNS.length]!;
    expect(parts.posX[P]).toBeCloseTo(expected.x);
    // With this script the respawn point differs from the initial spawn —
    // the inconsistency the review flagged.
    expect(expected.x).not.toBe(SPAWNS[0]!.x);
  });
});

describe('jet refuel', () => {
  it('trickles 1/tick while airborne with the burner off', () => {
    const { g } = soloGame();
    player(g).jetsCount = 0;
    run(g, 5);
    expect(player(g).jetsCount).toBe(5 * DEFAULT_TUNING.jetAirRegenPerTick);
  });

  it('never refuels past jetFuelMax', () => {
    const { g } = soloGame();
    player(g).jetsCount = DEFAULT_TUNING.jetFuelMax - 2;
    run(g, 5);
    expect(player(g).jetsCount).toBe(DEFAULT_TUNING.jetFuelMax);
  });
});

describe('team assignment', () => {
  it('a single human stays teamless even with teams on', () => {
    const g = new Game({ seed: 3, teams: true, botCount: 4 });
    expect(g.teamsEnabled).toBe(true);
    expect(g.teamOf(P)).toBe(0);
  });

  it('two humans alternate red/blue; bots alternate after them', () => {
    const g = new Game({ seed: 3, teams: true, humanCount: 2, botCount: 4 });
    expect(g.humanIndices).toEqual([1, 2]);
    expect(g.teamOf(1)).toBe(1);
    expect(g.teamOf(2)).toBe(2);
    expect(g.botIndices()).toEqual([3, 4, 5, 6]);
    expect(g.botIndices().map((i) => g.teamOf(i))).toEqual([1, 2, 1, 2]);
  });

  it('FFA (teams off) leaves everyone teamless', () => {
    const g = new Game({ seed: 3, botCount: 3 });
    expect(g.teamsEnabled).toBe(false);
    for (const i of [P, ...g.botIndices()]) expect(g.teamOf(i)).toBe(0);
  });
});
