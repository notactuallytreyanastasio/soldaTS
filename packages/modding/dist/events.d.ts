import type { ScriptPlayer } from './api';
export type ModEventName = 'OnClockTick' | 'OnJoin' | 'OnLeave' | 'OnJoinTeam' | 'OnPlayerKill' | 'OnFlagGrab' | 'OnFlagScore' | 'OnFlagReturn' | 'OnFlagDrop' | 'OnKitPickup' | 'OnWeaponChange' | 'OnAfterPlayerRespawn' | 'OnBeforeMapChange' | 'OnAfterMapChange' | 'OnPlayerSpeak' | 'OnVoteMap' | 'OnVoteKick' | 'OnAdminConnect' | 'OnAdminDisconnect' | 'OnAdminMessage' | 'OnPlayerDamage' | 'OnBeforeJoinTeam' | 'OnBeforePlayerRespawn' | 'OnRequestGame' | 'OnVoteMapStart' | 'OnVoteKickStart' | 'OnPlayerCommand' | 'OnConsoleCommand';
export type TeamFlagId = 0 | 1 | 2;
export interface Vec2Like {
    x: number;
    y: number;
}
export interface ModEventMap {
    OnClockTick: (ticks: number) => void;
    OnJoin: (player: ScriptPlayer, team: number) => void;
    OnLeave: (player: ScriptPlayer, kicked: boolean) => void;
    OnJoinTeam: (player: ScriptPlayer, team: number, oldTeam: number) => void;
    OnPlayerKill: (killer: ScriptPlayer, victim: ScriptPlayer, weapon: number) => void;
    OnFlagGrab: (player: ScriptPlayer, teamFlag: TeamFlagId, grabbedInBase: boolean) => void;
    OnFlagScore: (player: ScriptPlayer, teamFlag: TeamFlagId) => void;
    OnFlagReturn: (player: ScriptPlayer, teamFlag: TeamFlagId) => void;
    OnFlagDrop: (player: ScriptPlayer, teamFlag: TeamFlagId, thrown: boolean) => void;
    OnKitPickup: (player: ScriptPlayer, kitId: number) => void;
    OnWeaponChange: (player: ScriptPlayer, primary: number, secondary: number, primaryAmmo: number, secondaryAmmo: number) => void;
    OnAfterPlayerRespawn: (player: ScriptPlayer) => void;
    OnBeforeMapChange: (map: string) => void;
    OnAfterMapChange: (map: string) => void;
    OnPlayerSpeak: (player: ScriptPlayer, text: string) => void;
    OnVoteMap: (player: ScriptPlayer, map: string) => void;
    OnVoteKick: (player: ScriptPlayer, victim: ScriptPlayer) => void;
    OnAdminConnect: (ip: string, port: number) => void;
    OnAdminDisconnect: (ip: string, port: number) => void;
    OnAdminMessage: (ip: string, port: number, message: string) => void;
    OnPlayerDamage: (victim: ScriptPlayer, shooter: ScriptPlayer, damage: number) => number;
    OnBeforeJoinTeam: (player: ScriptPlayer, team: number, oldTeam: number) => number;
    OnBeforePlayerRespawn: (player: ScriptPlayer) => Vec2Like;
    OnRequestGame: (ip: string, hw: string, port: number, state: number, forwarded: boolean, password: string) => number;
    OnVoteMapStart: (player: ScriptPlayer, map: string) => boolean;
    OnVoteKickStart: (player: ScriptPlayer, victim: ScriptPlayer, reason: string) => boolean;
    OnPlayerCommand: (player: ScriptPlayer, command: string) => boolean;
    OnConsoleCommand: (ip: string, port: number, command: string) => boolean;
}
/**
 * How a host should combine the return values of an event's handlers across
 * the registered scripts.
 *
 * PORT: ScriptDispatcher.pas — three observed reduction strategies:
 *   'broadcast' — procedure events; no return chaining (most events).
 *   'chain'     — each handler's return becomes the next handler's input and the
 *                 final return is the result (OnPlayerDamage:687, OnRequestGame:443,
 *                 OnBeforeJoinTeam:460, OnBeforePlayerRespawn:655).
 *   'or'        — Boolean accumulation; any True wins (OnVoteMapStart:735,
 *                 OnVoteKickStart:750, OnPlayerCommand:808, OnConsoleCommand:823).
 */
export type ModEventCascade = 'broadcast' | 'chain' | 'or';
export declare const MOD_EVENT_CASCADE: Readonly<Record<ModEventName, ModEventCascade>>;
/** The complete set of mod event names (handy for host registration loops). */
export declare const MOD_EVENT_NAMES: readonly ModEventName[];
/** A handler bound to a specific event. */
export type ModEventHandler<E extends ModEventName> = ModEventMap[E];
//# sourceMappingURL=events.d.ts.map