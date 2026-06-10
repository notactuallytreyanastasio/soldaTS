// "classic" bot engine — the faithful OpenSoldat brain behind the adapter.
//
// Wraps the ported Pascal AI (sim updateBot: perception + distance-band
// combat + waypoint navigation) plus the client sustainment layer that made
// spectate matches viable: the absolute→relative aim conversion and the
// roam-when-targetless fallback. Behavior is identical to the pre-adapter
// code — this move is pure extraction (decision node 136).

import { createBotState, updateBot, type BotState } from '@soldat/sim';
import {
  createRoamState,
  roamTick,
  type BotBrain,
  type BotEngine,
  type BotEngineContext,
  type RoamState,
} from './engine';

class ClassicBrain implements BotBrain {
  private readonly brain: BotState = createBotState({ accuracy: 9 });
  private readonly roam: RoamState = createRoamState();

  tick(botIndex: number, ctx: BotEngineContext): void {
    const { world, graph, spectate } = ctx;
    const s = world.sprites[botIndex];
    const parts = world.spriteParts;
    if (s === undefined || parts === null) return;

    const aimXBefore = s.control.mouseAimX;
    const aimYBefore = s.control.mouseAimY;
    updateBot(world, botIndex, this.brain, graph);
    if (!spectate) return; // normal play: byte-identical to the old path

    // AIM FIX — the ported AI writes ABSOLUTE world coords into mouseAim
    // (the Pascal convention); this client treats mouseAim as a RELATIVE
    // offset from the shooter. Convert when the AI wrote an aim this tick.
    const px = parts.posX[botIndex] ?? 0;
    const py = parts.posY[botIndex] ?? 0;
    const wroteAim =
      this.brain.targetNum > 0 ||
      s.control.mouseAimX !== aimXBefore ||
      s.control.mouseAimY !== aimYBefore;
    if (wroteAim) {
      s.control.mouseAimX = Math.round(s.control.mouseAimX - px);
      s.control.mouseAimY = Math.round(s.control.mouseAimY - py);
    }

    // WANDER — keep targetless bots moving (shared roam helper).
    const idle =
      !s.control.fire && !s.control.left && !s.control.right && !s.control.up;
    if (!idle) {
      this.roam.stuckTicks = 0;
      return;
    }
    roamTick(this.roam, botIndex, ctx);
  }
}

export function createClassicEngine(): BotEngine {
  return {
    id: 'classic',
    strategy: 'REFLEX BANDS — faithful Pascal port: react by distance, fight where you stand',
    createBrain: (): BotBrain => new ClassicBrain(),
  };
}
