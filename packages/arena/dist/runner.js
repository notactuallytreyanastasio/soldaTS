// MatchRunner (goal node 170): one COMPLETE headless deathmatch, far faster
// than realtime — a 7200-tick (120 s) round finishes in a few seconds because
// game.tick(1/60) in a tight loop runs exactly one 60 Hz sim step per call
// with zero wall-clock coupling.
//
// DETERMINISM: the runner introduces no ambient randomness or wall-clock
// reads into the recorded artifacts (timing/printing lives in cli.ts only).
// Same MatchConfig ⇒ byte-identical replayJsonl, events, telemetry.
import { Game, MatchRecorder, generateArena, engineIds, resolveVariant, resolveWildcard, subjectName, } from '@soldat/client/headless';
import { buildReplayRow, rowsToJsonl, } from './replay';
const DEFAULT_BOT_COUNT = 6;
const DEFAULT_ROUND_TICKS = 7200; // 120 s at 60 Hz
const TICK_DT = 1 / 60;
/** Run one complete headless deathmatch; throws on invalid team specs. */
export function runMatch(config) {
    const [red, blue] = config.teams;
    // v1 limitation: Game groups teams by engine ID, so the same engine on
    // both sides would collapse into one team. Same-engine-different-tweaks
    // needs engine aliasing — next slice.
    if (red.engine === blue.engine) {
        throw new Error("mirror matches (same engine both sides) aren't supported yet: Game groups teams by engine id");
    }
    // Unknown ids would silently fall back to classic and corrupt the
    // dataset's provenance — refuse instead.
    for (const spec of config.teams) {
        if (!engineIds().includes(spec.engine)) {
            throw new Error(`unknown engine '${spec.engine}' (registered: ${engineIds().join(', ')})`);
        }
    }
    const variant = resolveVariant(config.variant);
    const botCount = config.botCount ?? DEFAULT_BOT_COUNT;
    const roundTicks = config.roundTicks ?? DEFAULT_ROUND_TICKS;
    const maxTicks = config.maxTicks ?? roundTicks + 600;
    const arena = generateArena(config.arenaSeed ?? 0);
    // Resolve the wildcard MODE to this match's armed value — 'chance' is a
    // pure function of the seed, so the manifest (config + seed) still fully
    // determines every recorded byte.
    const wildcard = resolveWildcard(config.wildcard, config.seed);
    const game = new Game({
        seed: config.seed,
        spawns: arena.spawns,
        botCount,
        spectate: true,
        aiEngine: `${red.engine},${blue.engine}`, // red = group 0, blue = group 1
        teams: true,
        tuning: variant.tuning,
        roundTicks,
        wildcard,
        engineTweaks: {
            ...(red.tweaks ? { [red.engine]: red.tweaks } : {}),
            ...(blue.tweaks ? { [blue.engine]: blue.tweaks } : {}),
        },
    });
    game.loadMap(arena.map);
    // Recorder FIRST: its constructor claims game.onShot and world.onDamage —
    // the event-stream taps below CHAIN onto whatever it installed.
    const recorder = new MatchRecorder(game, 'Skyreach', botCount, true, variant.name);
    const events = [];
    const tick = () => game.world.mainTickCounter;
    const prevShot = game.onShot;
    game.onShot = (shooter) => {
        prevShot?.(shooter);
        events.push({ tick: tick(), type: 'shot', bot: shooter });
    };
    const prevDamage = game.world.onDamage;
    game.world.onDamage = (victim, attacker, amount) => {
        prevDamage?.(victim, attacker, amount);
        if (attacker > 0 && attacker !== victim) {
            events.push({
                tick: tick(),
                type: 'hit',
                attacker,
                victim,
                damage: Number(amount.toFixed(1)),
            });
        }
    };
    game.onKill = (killer, victim) => {
        recorder.recordKill(killer, victim);
        // Positions read NOW (same instant recordKill uses), same rounding.
        const parts = game.world.spriteParts;
        const pos = (i) => ({
            x: Math.round(parts?.posX[i] ?? 0),
            y: Math.round(parts?.posY[i] ?? 0),
        });
        const attributed = killer > 0 && killer !== victim;
        const victimPos = pos(victim);
        const killerPos = attributed ? pos(killer) : null;
        events.push({
            tick: tick(),
            type: 'kill',
            killer,
            victim,
            killerPos,
            victimPos,
            dist: killerPos !== null
                ? Math.round(Math.hypot(killerPos.x - victimPos.x, killerPos.y - victimPos.y))
                : null,
            // Weapon tag only when a wildcard is armed: default-run event streams
            // keep their exact pre-wildcard shape.
            ...(game.wildcard !== undefined && attributed
                ? { weapon: game.weaponNameOf(killer) }
                : {}),
        });
    };
    // Replay sampling: post-think, pre-physics (see replay.ts header).
    const rows = [];
    game.onBrainsTicked = (t) => {
        for (const i of game.botIndices()) {
            const row = buildReplayRow(game, i, t);
            if (row !== null)
                rows.push(row);
        }
    };
    // Tick loop — one sim tick per call; maxTicks is a hard safety cap (a
    // teams+roundTicks game always freezes itself first).
    while (game.roundResult === null && game.world.mainTickCounter < maxTicks) {
        game.tick(TICK_DT);
        recorder.maybeSample();
    }
    const bots = game.botIndices().map((index) => ({
        index,
        name: subjectName(index, game.playerIndex, config.seed * 7),
        engine: game.engineOf(index),
        team: game.teamOf(index),
    }));
    return {
        seed: config.seed,
        wildcard: wildcard ?? null,
        ticks: game.world.mainTickCounter,
        round: game.roundResult,
        telemetry: recorder.dump(),
        replayJsonl: rowsToJsonl(rows),
        events,
        bots,
        tuning: game.tuning,
        resolvedTweaks: [
            { ...(game.resolvedTweaks(red.engine) ?? {}) },
            { ...(game.resolvedTweaks(blue.engine) ?? {}) },
        ],
    };
}
//# sourceMappingURL=runner.js.map