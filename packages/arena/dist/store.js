// Dataset store (goal node 170): writes one run directory per CLI invocation
// under soldat-ts/datasets/<runId>/ with FULL provenance — manifest (git rev,
// resolved tweaks, resolved tuning, seeds), per-match replay + events (both
// gzipped JSONL),
// telemetry, events, and a cross-match summary. The format is documented for
// trainers in soldat-ts/datasets/README.md — bump the schema ids on any
// breaking shape change, never mutate them silently.
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as zlib from 'node:zlib';
import { eventsToJsonl } from './replay';
export const MANIFEST_SCHEMA = 'soldat-arena-replay/2'; // dataset format id
export const SUMMARY_SCHEMA = 'soldat-arena-summary/1';
/** `YYYYMMDD-HHMMSS-<a>-vs-<b>[-<suffix>]` (UTC; `now` injectable for tests). */
export function makeRunId(teamA, teamB, suffix, now) {
    const d = now ?? new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
        `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
    return `${stamp}-${teamA}-vs-${teamB}${suffix !== undefined && suffix !== '' ? `-${suffix}` : ''}`;
}
/** `git rev-parse HEAD` from this file's directory; 'unknown' on any failure. */
export function gitRev() {
    try {
        return execSync('git rev-parse HEAD', {
            cwd: path.dirname(fileURLToPath(import.meta.url)),
            encoding: 'utf8',
        }).trim();
    }
    catch {
        return 'unknown';
    }
}
/** Build the run manifest (pure apart from gitRev's subprocess). */
export function buildManifest(args) {
    const first = args.results[0];
    if (first === undefined)
        throw new Error('buildManifest: no match results');
    const teamManifest = (side) => ({
        team: (side + 1),
        engine: args.teams[side].engine,
        requestedTweaks: { ...(args.teams[side].tweaks ?? {}) },
        resolvedTweaks: { ...first.resolvedTweaks[side] },
    });
    return {
        schema: MANIFEST_SCHEMA,
        runId: args.runId,
        createdAt: (args.now ?? new Date()).toISOString(),
        gitRev: gitRev(),
        map: 'Skyreach',
        botCount: args.botCount,
        roundTicks: args.roundTicks,
        maxTicks: args.maxTicks,
        variant: { name: args.variantName, tuning: { ...first.tuning } },
        wildcard: args.wildcard === undefined || args.wildcard === 'none' ? null : args.wildcard,
        teams: [teamManifest(0), teamManifest(1)],
        matches: args.results.map((r, i) => ({
            n: i + 1,
            seed: r.seed,
            wildcard: r.wildcard ?? null,
            files: {
                replay: `match-${i + 1}.replay.jsonl.gz`,
                telemetry: `match-${i + 1}.telemetry.json.gz`,
                events: `match-${i + 1}.events.jsonl.gz`,
            },
        })),
        cli: args.cli ?? null,
    };
}
/** Aggregate standings across matches (pure). */
export function buildSummary(results) {
    const matches = [];
    const teamTotals = {
        red: { engine: '', wins: 0, kills: 0, deaths: 0, dominance: 0 },
        blue: { engine: '', wins: 0, kills: 0, deaths: 0, dominance: 0 },
    };
    let draws = 0;
    // Per-bot rows summed across matches, keyed by sprite index (sprite
    // identities are stable: same index = same seat in every match).
    const botTotals = new Map();
    results.forEach((r, i) => {
        const round = r.round;
        // A null round (maxTicks cap) counts as a draw row with winnerTeam 0.
        matches.push({
            n: i + 1,
            seed: r.seed,
            ticks: r.ticks,
            winnerTeam: (round?.winnerTeam ?? 0),
            winnerEngine: round?.winnerEngine ?? '',
            redKills: round?.redKills ?? 0,
            blueKills: round?.blueKills ?? 0,
            redDom: round?.redDom ?? 0,
            blueDom: round?.blueDom ?? 0,
        });
        if (round === null || round.winnerTeam === 0)
            draws += 1;
        else if (round.winnerTeam === 1)
            teamTotals.red.wins += 1;
        else
            teamTotals.blue.wins += 1;
        for (const bot of r.bots) {
            const side = bot.team === 1 ? teamTotals.red : teamTotals.blue;
            if (side.engine === '')
                side.engine = bot.engine;
            const derived = r.telemetry.derived.perSprite[bot.index];
            const kills = derived?.kills ?? 0;
            const deaths = derived?.deaths ?? 0;
            side.kills += kills;
            side.deaths += deaths;
            side.dominance += kills - 0.5 * deaths;
            const tally = botTotals.get(bot.index) ?? {
                name: bot.name,
                engine: bot.engine,
                team: bot.team,
                kills: 0,
                deaths: 0,
                shots: 0,
                hits: 0,
            };
            tally.kills += kills;
            tally.deaths += deaths;
            tally.shots += derived?.shots ?? 0;
            tally.hits += derived?.hits ?? 0;
            botTotals.set(bot.index, tally);
        }
    });
    const winner = teamTotals.red.wins > teamTotals.blue.wins
        ? teamTotals.red.engine
        : teamTotals.blue.wins > teamTotals.red.wins
            ? teamTotals.blue.engine
            : teamTotals.red.kills > teamTotals.blue.kills
                ? teamTotals.red.engine
                : teamTotals.blue.kills > teamTotals.red.kills
                    ? teamTotals.blue.engine
                    : '';
    const bots = [...botTotals.values()]
        .map((b) => ({
        name: b.name,
        engine: b.engine,
        team: b.team,
        kills: b.kills,
        deaths: b.deaths,
        shots: b.shots,
        hits: b.hits,
        hitRate: b.shots > 0 ? b.hits / b.shots : 0,
    }))
        .sort((a, b) => b.kills - a.kills);
    return {
        schema: SUMMARY_SCHEMA,
        matches,
        standings: { red: teamTotals.red, blue: teamTotals.blue, draws, winner },
        bots,
    };
}
/**
 * Write one run directory: per-match replay (gzipped), telemetry, events,
 * plus manifest.json and summary.json. Returns the absolute run directory.
 */
export function writeRun(baseDir, runId, manifest, results) {
    const dir = path.join(baseDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    results.forEach((r, i) => {
        const n = i + 1;
        fs.writeFileSync(path.join(dir, `match-${n}.replay.jsonl.gz`), zlib.gzipSync(Buffer.from(r.replayJsonl)));
        // Telemetry gzips too (~8:1) — it was 29% of corpus bytes as raw JSON.
        // Readers resolve names via the manifest and sniff the gzip magic.
        fs.writeFileSync(path.join(dir, `match-${n}.telemetry.json.gz`), zlib.gzipSync(Buffer.from(JSON.stringify(r.telemetry, null, 2))));
        // Events gzip too — every post-game JSONL artifact is compressed (the
        // manifest's files[] entries are the source of truth for exact names).
        fs.writeFileSync(path.join(dir, `match-${n}.events.jsonl.gz`), zlib.gzipSync(Buffer.from(eventsToJsonl(r.events))));
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(buildSummary(results), null, 2));
    return path.resolve(dir);
}
//# sourceMappingURL=store.js.map