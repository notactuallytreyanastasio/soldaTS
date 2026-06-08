// @soldat/modding — sample mod exercising the ScriptHost contract.
//
// A tiny "double-damage + welcome" mod. It demonstrates:
//   - on('OnPlayerDamage', ...) participating in the cascade (returns modified damage)
//   - on('OnJoin', ...) reacting to a join (a side-effecting, void handler)
//
// PORT (conceptual): a ScriptCore unit that implements OnPlayerDamage / OnJoinGame.
//   ScriptCore.pas:387–397 (OnPlayerDamage chain) and ScriptCore.pas:308–316 (join).
//
// Mods are plain factories: given a ModContext they subscribe handlers. No file
// loading, no PascalScript compilation — registration is explicit and typed.

import type { ModContext, ModFactory } from './host.js';
import type { ScriptPlayer } from './api.js';

/** Records of who was welcomed — lets tests/consumers observe the join side-effect. */
export interface SampleModLog {
  readonly welcomed: string[];
}

/**
 * Create the double-damage / welcome mod.
 *
 * @param log  optional sink the OnJoin handler appends greeted player names to.
 * @param multiplier  damage multiplier (default 2 = "double damage").
 */
export function createDoubleDamageMod(
  log: SampleModLog = { welcomed: [] },
  multiplier = 2,
): ModFactory {
  // Named function so the host derives a stable mod name from `.name`.
  return function doubleDamageMod(ctx: ModContext): void {
    // CASCADE handler: scale the incoming (already-possibly-modified) damage.
    ctx.on('OnPlayerDamage', (victim: ScriptPlayer, shooter: ScriptPlayer, damage: number): number => {
      // Self-damage is left untouched — a common modding nicety.
      if (victim.id === shooter.id) return damage;
      return damage * multiplier;
    });

    // VOID handler: greet a joining player (pure side-effect via the api/log).
    ctx.on('OnJoin', (player: ScriptPlayer, _team: number): void => {
      log.welcomed.push(player.name);
    });
  };
}

/** A ready-to-load instance using a fresh log (exported for convenience/tests). */
export const sampleModLog: SampleModLog = { welcomed: [] };
export const sampleMod: ModFactory = createDoubleDamageMod(sampleModLog);
