// Shotgun wildcard + per-bot weapons (SPAS-12 from the shared weapon contract):
//
//   (a) pellet fan: one bullet spawn per pellet (SPAS_PELLETS), spread drawn
//       from world.rng only — same seed ⇒ byte-identical pellet velocities,
//   (b) wildcard carrier pick is deterministic from the match seed (one
//       carrier per team; one total in FFA),
//   (c) a wildcard spectate match sustains itself (engine.test.ts pattern),
//   (d) regression: the default no-wildcard Game is unchanged — everyone on
//       the AK74, zero rng consumed by setup beyond initSimWorld.
//
// Player weapon swap (Tab/B → control.changeWeapon): toggles AK74 ⇄ SPAS12,
// each slot keeps its OWN ammo/reload state, and swapping mid-reload cancels
// that reload.

import { describe, it, expect } from 'vitest';
import { BulletStyle, createWorld, initSimWorld } from '@soldat/sim';
import { Game, DEFAULT_TUNING, SPAS_PELLETS } from './game';
import { rollWildcard, pickWildcardWeapon, resolveWildcard } from './wildcardChance';
import { buildArena, ARENA_SPAWNS } from './arena';

const TICK_DT = 1 / 60;

/** Pulse changeWeapon for one tick (rising edge = one toggle). */
function swapWeapon(game: Game, index: number): void {
  const s = game.world.sprites[index]!;
  s.control = { ...s.control, changeWeapon: true };
  game.tick(TICK_DT);
  s.control = { ...s.control, changeWeapon: false };
  game.tick(TICK_DT);
}

/** Player-only Game (no bots) — isolates the weapon state machine. */
function soloGame(seed = 5): Game {
  return new Game({ seed, spawns: [{ x: 0, y: 0 }], botCount: 0 });
}

/** Active bullets as [vx, vy, style] triples (spawn-order stable). */
function activeBullets(game: Game): [number, number, number][] {
  const bp = game.world.bulletParts!;
  const out: [number, number, number][] = [];
  for (let i = 1; i < game.world.bullets.length; i++) {
    const b = game.world.bullets[i];
    if (b === undefined || !b.active) continue;
    out.push([bp.velocityX[i] ?? 0, bp.velocityY[i] ?? 0, b.style]);
  }
  return out;
}

describe('SPAS-12 pellet fan (the Pascal rule: one spawn per pellet)', () => {
  function fireOneSpasShot(seed: number): { game: Game; shots: number } {
    const game = soloGame(seed);
    let shots = 0;
    game.onShot = (): void => {
      shots += 1;
    };
    swapWeapon(game, game.playerIndex);
    expect(game.weaponNameOf(game.playerIndex)).toBe('SPAS12');
    const p = game.world.sprites[game.playerIndex]!;
    p.control = { ...p.control, fire: true, mouseAimX: 100, mouseAimY: 0 };
    game.tick(TICK_DT);
    p.control = { ...p.control, fire: false };
    return { game, shots };
  }

  it('spawns exactly SPAS_PELLETS SHOTGUN-style bullets per trigger pull', () => {
    const { game, shots } = fireOneSpasShot(5);
    const bullets = activeBullets(game);
    expect(bullets).toHaveLength(SPAS_PELLETS);
    for (const [, , style] of bullets) expect(style).toBe(BulletStyle.SHOTGUN);
    // One trigger pull = ONE shot event and ONE round of ammo.
    expect(shots).toBe(1);
    // Spread did its job: the pellets are not all collinear.
    const angles = new Set(bullets.map(([vx, vy]) => Math.atan2(vy, vx).toFixed(6)));
    expect(angles.size).toBeGreaterThan(1);
  });

  it('pellet spread is rng-deterministic: same seed ⇒ identical velocities', () => {
    const a = fireOneSpasShot(5).game;
    const b = fireOneSpasShot(5).game;
    expect(activeBullets(a)).toEqual(activeBullets(b));
    const c = fireOneSpasShot(6).game;
    expect(activeBullets(c)).not.toEqual(activeBullets(a));
  });
});

describe('player weapon swap (Tab/B → control.changeWeapon)', () => {
  it('cycles AK74 → SPAS12 → BARRETT → AK74 on the RISING edge only', () => {
    const game = soloGame();
    const p = game.world.sprites[game.playerIndex]!;
    expect(game.weaponNameOf(game.playerIndex)).toBe('AK74');
    // Held across several ticks = ONE swap, not one per tick.
    p.control = { ...p.control, changeWeapon: true };
    for (let t = 0; t < 5; t++) game.tick(TICK_DT);
    expect(game.weaponNameOf(game.playerIndex)).toBe('SPAS12');
    p.control = { ...p.control, changeWeapon: false };
    game.tick(TICK_DT);
    swapWeapon(game, game.playerIndex);
    expect(game.weaponNameOf(game.playerIndex)).toBe('BARRETT');
    swapWeapon(game, game.playerIndex);
    expect(game.weaponNameOf(game.playerIndex)).toBe('AK74');
  });

  it('each weapon keeps its OWN ammo (a swap is not a free reload)', () => {
    const game = soloGame();
    const p = game.world.sprites[game.playerIndex]!;
    swapWeapon(game, game.playerIndex);
    const spasMag = game.playerAmmo();
    expect(spasMag).toBeLessThan(DEFAULT_TUNING.magSize); // SPAS mag is smaller
    // Spend one SPAS shell.
    p.control = { ...p.control, fire: true, mouseAimX: 100, mouseAimY: 0 };
    game.tick(TICK_DT);
    p.control = { ...p.control, fire: false };
    expect(game.playerAmmo()).toBe(spasMag - 1);
    // AK magazine untouched; SPAS count survives the trip around the ring
    // (SPAS → BARRETT → AK → SPAS).
    swapWeapon(game, game.playerIndex);
    swapWeapon(game, game.playerIndex);
    expect(game.playerAmmo()).toBe(DEFAULT_TUNING.magSize);
    swapWeapon(game, game.playerIndex);
    expect(game.playerAmmo()).toBe(spasMag - 1);
  });

  it('swapping mid-reload CANCELS that reload (classic Soldat feel)', () => {
    const game = soloGame();
    const p = game.world.sprites[game.playerIndex]!;
    swapWeapon(game, game.playerIndex);
    const spasMag = game.playerAmmo();
    // Spend a shell, then start a manual reload.
    p.control = { ...p.control, fire: true, mouseAimX: 100, mouseAimY: 0 };
    game.tick(TICK_DT);
    p.control = { ...p.control, fire: false, reload: true };
    game.tick(TICK_DT);
    p.control = { ...p.control, reload: false };
    expect(game.playerReloading()).toBe(true);
    // Swap away and back around the ring: the reload is gone, the magazine
    // stayed partial.
    swapWeapon(game, game.playerIndex);
    swapWeapon(game, game.playerIndex);
    swapWeapon(game, game.playerIndex);
    expect(game.weaponNameOf(game.playerIndex)).toBe('SPAS12');
    expect(game.playerReloading()).toBe(false);
    expect(game.playerAmmo()).toBe(spasMag - 1);
  });
});

describe('shotgun wildcard distribution', () => {
  const opts = {
    seed: 42,
    spawns: ARENA_SPAWNS,
    botCount: 6,
    spectate: true,
    aiEngine: 'classic,pilot',
    wildcard: 'shotgun',
  } as const;

  it('arms exactly one carrier per team, deterministically from the seed', () => {
    const a = new Game({ ...opts });
    const b = new Game({ ...opts });
    expect(a.teamsEnabled).toBe(true);
    expect(a.wildcardCarriers()).toEqual(b.wildcardCarriers());
    expect(a.wildcardCarriers()).toHaveLength(2);
    const teams = a.wildcardCarriers().map((i) => a.teamOf(i)).sort();
    expect(teams).toEqual([1, 2]);
    for (const i of a.wildcardCarriers()) {
      expect(a.weaponNameOf(i)).toBe('SPAS12');
    }
    for (const i of a.botIndices()) {
      if (!a.wildcardCarriers().includes(i)) expect(a.weaponNameOf(i)).toBe('AK74');
    }
  });

  it('FFA (no teams) arms exactly one carrier total', () => {
    const game = new Game({
      seed: 9,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      wildcard: 'shotgun',
    });
    expect(game.teamsEnabled).toBe(false);
    expect(game.wildcardCarriers()).toHaveLength(1);
  });

  it('the carrier respawns WITH the SPAS-12', () => {
    const game = new Game({
      seed: 9,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      wildcard: 'shotgun',
    });
    game.loadMap(buildArena());
    const carrier = game.wildcardCarriers()[0]!;
    game.world.sprites[carrier]!.health = 0;
    for (let t = 0; t < 260; t++) game.tick(TICK_DT); // respawnTicks 180 + slack
    const s = game.world.sprites[carrier]!;
    expect(s.active && !s.deadMeat).toBe(true);
    expect(game.weaponNameOf(carrier)).toBe('SPAS12');
  });
});

describe('wildcard spectate match (sustainment, engine.test.ts pattern)', () => {
  it('sustains kills and respawns over 6000 ticks with the wildcard on', () => {
    const game = new Game({
      seed: 7,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      aiEngine: 'classic,pilot',
      teams: true,
      wildcard: 'shotgun',
    });
    game.loadMap(buildArena());
    expect(game.wildcardCarriers()).toHaveLength(2);

    const kills: { killer: number; victim: number }[] = [];
    game.onKill = (killer, victim): void => {
      kills.push({ killer, victim });
    };

    for (let t = 0; t < 6000; t++) game.tick(TICK_DT);

    expect(kills.length).toBeGreaterThan(0);
    const alive = game.botIndices().filter((i) => game.world.sprites[i]?.active).length;
    expect(alive).toBe(4);
    expect(game.world.sprites[game.playerIndex]?.active).toBe(false);
    // Carriers still SPAS-armed after deaths/respawns along the way.
    for (const i of game.wildcardCarriers()) {
      expect(game.weaponNameOf(i)).toBe('SPAS12');
    }
  });
});

describe('regression: default (no wildcard) behavior unchanged', () => {
  it('everyone defaults to the AK74 and no wildcard carrier exists', () => {
    const game = new Game({ seed: 1, spawns: ARENA_SPAWNS, botCount: 4, spectate: true });
    expect(game.wildcard).toBeUndefined();
    expect(game.wildcardCarriers()).toEqual([]);
    for (const i of [game.playerIndex, ...game.botIndices()]) {
      expect(game.weaponNameOf(i)).toBe('AK74');
    }
  });

  it('wildcard-off setup consumes ZERO world.rng (stream matches a bare world)', () => {
    const game = new Game({ seed: 123, spawns: ARENA_SPAWNS, botCount: 4, spectate: true });
    const bare = createWorld();
    initSimWorld(bare, { seed: 123 });
    // Same next draw ⇒ Game's constructor pulled nothing from the stream.
    expect(game.world.rng.next()).toBe(bare.rng.next());
  });

  it('explicit wildcard: undefined is byte-identical to omitting it (2000 ticks)', () => {
    const positions = (game: Game): number[] => {
      const parts = game.world.spriteParts!;
      return game.botIndices().flatMap((i) => [parts.posX[i] ?? 0, parts.posY[i] ?? 0]);
    };
    const run = (extra: { wildcard?: string | undefined }): Game => {
      const game = new Game({
        seed: 11,
        spawns: ARENA_SPAWNS,
        botCount: 4,
        spectate: true,
        ...extra,
      });
      game.loadMap(buildArena());
      for (let t = 0; t < 2000; t++) game.tick(TICK_DT);
      return game;
    };
    expect(positions(run({ wildcard: undefined }))).toEqual(positions(run({})));
  });
});

// ---------------------------------------------------------------------------
// Barrett (goal node 382): the third weapon slot — one-hit-kill sniper rifle
// behind the 'rifle' wildcard. Charge-up, cadence/mag/reload numbers, the
// three-way swap ring, rifle-carrier determinism, and the two-wildcard
// 'chance' mode are pinned here; the OHK + degradation-exemption ballistics
// are proven at the sim level (packages/sim entities/bullet.test.ts).
// ---------------------------------------------------------------------------

/** Stock Barrett numbers (deriveSlotTuning over DEFAULT_TUNING):
 *  fireInterval 225*6/10 = 135, mag 3 (override), reload 210 (override),
 *  charge = contract startUpTime 19. */
const BARRETT_FIRE_INTERVAL = 135;
const BARRETT_MAG = 3;
const BARRETT_RELOAD = 210;
const BARRETT_STARTUP = 19;

/** Swap the solo player to the Barrett (two hops around the ring). */
function toBarrett(game: Game): void {
  swapWeapon(game, game.playerIndex);
  swapWeapon(game, game.playerIndex);
  expect(game.weaponNameOf(game.playerIndex)).toBe('BARRETT');
}

describe('player weapon swap cycles all three slots', () => {
  it('Tab/B walks AK74 → SPAS12 → BARRETT → AK74', () => {
    const game = soloGame();
    expect(game.weaponNameOf(game.playerIndex)).toBe('AK74');
    swapWeapon(game, game.playerIndex);
    expect(game.weaponNameOf(game.playerIndex)).toBe('SPAS12');
    swapWeapon(game, game.playerIndex);
    expect(game.weaponNameOf(game.playerIndex)).toBe('BARRETT');
    swapWeapon(game, game.playerIndex);
    expect(game.weaponNameOf(game.playerIndex)).toBe('AK74');
  });

  it('the Barrett slot keeps its own 3-round magazine across swaps', () => {
    const game = soloGame();
    toBarrett(game);
    expect(game.playerAmmo()).toBe(BARRETT_MAG);
    swapWeapon(game, game.playerIndex); // → AK
    expect(game.playerAmmo()).toBe(DEFAULT_TUNING.magSize);
  });
});

describe('Barrett charge-up (contract startUpTime 19)', () => {
  function holdFire(game: Game, ticks: number): void {
    const p = game.world.sprites[game.playerIndex]!;
    p.control = { ...p.control, fire: true, mouseAimX: 100, mouseAimY: 0 };
    for (let t = 0; t < ticks; t++) game.tick(TICK_DT);
  }
  function releaseFire(game: Game, ticks = 1): void {
    const p = game.world.sprites[game.playerIndex]!;
    p.control = { ...p.control, fire: false };
    for (let t = 0; t < ticks; t++) game.tick(TICK_DT);
  }

  it('holding fire delays the shot exactly startUpTime ticks', () => {
    const game = soloGame();
    toBarrett(game);
    holdFire(game, BARRETT_STARTUP);
    expect(activeBullets(game)).toHaveLength(0); // 19 held ticks: still charging
    holdFire(game, 1); // the 20th tick releases the round
    expect(activeBullets(game)).toHaveLength(1);
    expect(game.playerAmmo()).toBe(BARRETT_MAG - 1);
  });

  it('releasing fire mid-charge CANCELS — the next pull starts from zero', () => {
    const game = soloGame();
    toBarrett(game);
    holdFire(game, 15); // 15/19 charged...
    releaseFire(game); // ...and cancelled
    holdFire(game, BARRETT_STARTUP); // a fresh pull needs the FULL charge
    expect(activeBullets(game)).toHaveLength(0);
    holdFire(game, 1);
    expect(activeBullets(game)).toHaveLength(1);
  });

  it('swapping away mid-charge also cancels', () => {
    const game = soloGame();
    toBarrett(game);
    holdFire(game, 15);
    releaseFire(game);
    swapWeapon(game, game.playerIndex); // → AK
    swapWeapon(game, game.playerIndex); // → SPAS
    swapWeapon(game, game.playerIndex); // → BARRETT
    holdFire(game, BARRETT_STARTUP);
    expect(activeBullets(game)).toHaveLength(0);
  });

  it('sustained fire cadence = fireInterval + charge (135 + 19 ticks)', () => {
    const game = soloGame();
    toBarrett(game);
    const shotTicks: number[] = [];
    game.onShot = (): void => {
      shotTicks.push(game.world.mainTickCounter);
    };
    holdFire(game, BARRETT_STARTUP + 1 + BARRETT_FIRE_INTERVAL + BARRETT_STARTUP + 5);
    expect(shotTicks).toHaveLength(2);
    expect(shotTicks[1]! - shotTicks[0]!).toBe(BARRETT_FIRE_INTERVAL + BARRETT_STARTUP);
  });

  it('the round is a single PLAIN bullet at contract speed 55', () => {
    const game = soloGame();
    toBarrett(game);
    const p = game.world.sprites[game.playerIndex]!;
    p.control = { ...p.control, fire: true, mouseAimX: 100, mouseAimY: 0 };
    for (let t = 0; t <= BARRETT_STARTUP; t++) game.tick(TICK_DT);
    const bullets = activeBullets(game);
    expect(bullets).toHaveLength(1);
    const [vx, vy, style] = bullets[0]!;
    expect(style).toBe(BulletStyle.PLAIN);
    expect(Math.hypot(vx, vy)).toBeCloseTo(55, 3);
  });
});

describe('Barrett magazine + reload numbers (pinned)', () => {
  it('manual reload takes 210 ticks and refills the 3-round mag', () => {
    const game = soloGame();
    toBarrett(game);
    const p = game.world.sprites[game.playerIndex]!;
    // Spend one round.
    p.control = { ...p.control, fire: true, mouseAimX: 100, mouseAimY: 0 };
    for (let t = 0; t <= BARRETT_STARTUP; t++) game.tick(TICK_DT);
    p.control = { ...p.control, fire: false };
    game.tick(TICK_DT);
    expect(game.playerAmmo()).toBe(BARRETT_MAG - 1);
    // R: the long sniper reload.
    p.control = { ...p.control, reload: true };
    game.tick(TICK_DT);
    p.control = { ...p.control, reload: false };
    expect(game.playerReloading()).toBe(true);
    for (let t = 0; t < BARRETT_RELOAD - 2; t++) game.tick(TICK_DT);
    expect(game.playerReloading()).toBe(true); // still chambering at t-1
    for (let t = 0; t < 4; t++) game.tick(TICK_DT);
    expect(game.playerReloading()).toBe(false);
    expect(game.playerAmmo()).toBe(BARRETT_MAG);
  });
});

describe('rifle wildcard distribution (one Barrett carrier per team)', () => {
  const opts = {
    seed: 42,
    spawns: ARENA_SPAWNS,
    botCount: 6,
    spectate: true,
    aiEngine: 'classic,pilot',
    wildcard: 'rifle',
  } as const;

  it('arms exactly one carrier per team, deterministically from the seed', () => {
    const a = new Game({ ...opts });
    const b = new Game({ ...opts });
    expect(a.teamsEnabled).toBe(true);
    expect(a.wildcardCarriers()).toEqual(b.wildcardCarriers());
    expect(a.wildcardCarriers()).toHaveLength(2);
    const teams = a.wildcardCarriers().map((i) => a.teamOf(i)).sort();
    expect(teams).toEqual([1, 2]);
    for (const i of a.wildcardCarriers()) {
      expect(a.weaponNameOf(i)).toBe('BARRETT');
    }
    for (const i of a.botIndices()) {
      if (!a.wildcardCarriers().includes(i)) expect(a.weaponNameOf(i)).toBe('AK74');
    }
  });

  it('same seed arms the SAME carrier indices as the shotgun wildcard (one rng draw per pool, identical order)', () => {
    const rifle = new Game({ ...opts });
    const shotgun = new Game({ ...opts, wildcard: 'shotgun' });
    expect(rifle.wildcardCarriers()).toEqual(shotgun.wildcardCarriers());
  });

  it('the carrier respawns WITH the Barrett', () => {
    const game = new Game({
      seed: 9,
      spawns: ARENA_SPAWNS,
      botCount: 4,
      spectate: true,
      wildcard: 'rifle',
    });
    game.loadMap(buildArena());
    expect(game.wildcardCarriers()).toHaveLength(1);
    const carrier = game.wildcardCarriers()[0]!;
    game.world.sprites[carrier]!.health = 0;
    for (let t = 0; t < 260; t++) game.tick(TICK_DT); // respawnTicks 180 + slack
    const s = game.world.sprites[carrier]!;
    expect(s.active && !s.deadMeat).toBe(true);
    expect(game.weaponNameOf(carrier)).toBe('BARRETT');
  });
});

describe("'chance' mode with two wildcards (35% armed, then shotgun|rifle 50/50)", () => {
  it('resolves armed seeds to pickWildcardWeapon and unarmed seeds to stock', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const resolved = resolveWildcard('chance', seed);
      if (rollWildcard(seed)) {
        expect(resolved).toBe(pickWildcardWeapon(seed));
      } else {
        expect(resolved).toBeUndefined();
      }
    }
  });

  it('ARMING decisions for old seeds are unchanged (the shotgun-era hash, pinned inline)', () => {
    // The exact pre-rifle rollWildcard formula, reproduced literally: if this
    // fails, recorded chance-era arming decisions have drifted.
    const legacyRoll = (seed: number): boolean =>
      (Math.imul(seed ^ 0x9e3779b9, 2654435761) >>> 0) % 100 < 35;
    for (let seed = 1; seed <= 300; seed++) {
      expect(rollWildcard(seed)).toBe(legacyRoll(seed));
    }
  });

  it('the weapon pick is a SEPARATE hash: all three outcomes occur and both picks appear among armed seeds', () => {
    const outcomes = new Set<string>();
    for (let seed = 1; seed <= 120; seed++) {
      outcomes.add(resolveWildcard('chance', seed) ?? 'none');
    }
    expect(outcomes).toEqual(new Set(['none', 'shotgun', 'rifle']));
  });

  it("forced modes pass through: 'rifle' → 'rifle', 'shotgun' → 'shotgun'", () => {
    expect(resolveWildcard('rifle', 7)).toBe('rifle');
    expect(resolveWildcard('shotgun', 7)).toBe('shotgun');
    expect(resolveWildcard('none', 7)).toBeUndefined();
    expect(resolveWildcard(undefined, 7)).toBeUndefined();
  });
});
