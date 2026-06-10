// @soldat/modding — mod event catalogue.
//
// Faithful TS port of the OpenSoldat ScriptCore/ScriptCore3 event surface and
// its dispatch/cascade semantics. The authoritative Pascal sources are:
//   - server/scriptcore/ScriptDispatcher.pas  (the singleton that iterates
//     registered scripts in REVERSE registration order and chains return values)
//   - server/scriptcore/ScriptCore.pas / ScriptCore3.pas  (per-script signatures)
// See also docs/rewrite-reference/pascalscript-api.md §"Event Dispatch & Cascade
// Semantics".
//
// Each entry below documents its source dispatcher method (ScriptDispatcher.pas
// line) and the published TScriptGame/TScript* signature it mirrors.

// PORT: server/scriptcore/ScriptPlayer.pas, ScriptGame.pas — the object model a
// mod sees. Imported as types only (verbatimModuleSyntax).
import type { ScriptPlayer } from './api';

// ---------------------------------------------------------------------------
// Event name union
// ---------------------------------------------------------------------------
//
// PORT: every name corresponds 1:1 to a TScriptDispatcher.On* method
// (ScriptDispatcher.pas:131-171). Where ScriptCore3 renames a dispatcher event
// for the published Game/Player event (e.g. dispatcher OnLeaveGame surfaces to
// scripts as Game.OnLeave), we keep the PUBLISHED name a mod author uses.

export type ModEventName =
  // --- broadcast (procedure) events ---
  | 'OnClockTick' //        PORT: ScriptDispatcher.pas:429 OnClockTick / Game.OnClockTick(Ticks)
  | 'OnJoin' //             PORT: ScriptDispatcher.pas:484 OnJoinTeam -> Game.OnJoin (JoinGame=True)
  | 'OnLeave' //            PORT: ScriptDispatcher.pas:498 OnLeaveGame -> Game.OnLeave
  | 'OnJoinTeam' //         PORT: ScriptDispatcher.pas:484 OnJoinTeam (team switch, JoinGame=False)
  | 'OnPlayerKill' //       PORT: ScriptDispatcher.pas:704 OnPlayerKill
  | 'OnFlagGrab' //         PORT: ScriptDispatcher.pas:585 OnFlagGrab
  | 'OnFlagScore' //        PORT: ScriptDispatcher.pas:599 OnFlagScore
  | 'OnFlagReturn' //       PORT: ScriptDispatcher.pas:613 OnFlagReturn
  | 'OnFlagDrop' //         PORT: ScriptDispatcher.pas:627 OnFlagDrop
  | 'OnKitPickup' //        PORT: ScriptDispatcher.pas:641 OnKitPickup
  | 'OnWeaponChange' //     PORT: ScriptDispatcher.pas:718 OnWeaponChange
  | 'OnAfterPlayerRespawn' //PORT: ScriptDispatcher.pas:673 OnAfterPlayerRespawn
  | 'OnBeforeMapChange' //  PORT: ScriptDispatcher.pas:513 OnBeforeMapChange / Map.OnBeforeMapChange
  | 'OnAfterMapChange' //   PORT: ScriptDispatcher.pas:527 OnAfterMapChange / Map.OnAfterMapChange
  | 'OnPlayerSpeak' //      PORT: ScriptDispatcher.pas:794 OnPlayerSpeak / Player.OnSpeak
  | 'OnVoteMap' //          PORT: ScriptDispatcher.pas:765 OnVoteMap
  | 'OnVoteKick' //         PORT: ScriptDispatcher.pas:779 OnVoteKick
  | 'OnAdminConnect' //     PORT: ScriptDispatcher.pas:542 OnAdminConnect
  | 'OnAdminDisconnect' //  PORT: ScriptDispatcher.pas:556 OnAdminDisconnect
  | 'OnAdminMessage' //     PORT: ScriptDispatcher.pas:570 OnAdminMessage
  // --- state-modifying (function) events whose return chains across scripts ---
  | 'OnPlayerDamage' //     PORT: ScriptDispatcher.pas:687 OnPlayerDamage (Single, chained)
  | 'OnBeforeJoinTeam' //   PORT: ScriptDispatcher.pas:460 OnBeforeJoinTeam (ShortInt, chained)
  | 'OnBeforePlayerRespawn' //PORT: ScriptDispatcher.pas:655 OnBeforePlayerRespawn (TVector2, chained)
  | 'OnRequestGame' //      PORT: ScriptDispatcher.pas:443 OnRequestGame (Integer state, chained)
  | 'OnVoteMapStart' //     PORT: ScriptDispatcher.pas:735 OnVoteMapStart (Boolean, OR-accumulated)
  | 'OnVoteKickStart' //    PORT: ScriptDispatcher.pas:750 OnVoteKickStart (Boolean, OR-accumulated)
  | 'OnPlayerCommand' //    PORT: ScriptDispatcher.pas:808 OnPlayerCommand (Boolean, OR-accumulated)
  | 'OnConsoleCommand'; //  PORT: ScriptDispatcher.pas:823 OnConsoleCommand (Boolean, OR-accumulated)

// ---------------------------------------------------------------------------
// A flag's position relative to the world (PORT: 0=Red, 1=Blue, 2=Yellow flag
// IDs as used by OnFlag* (ScriptDispatcher.pas:585-639, TeamFlag param)).
// ---------------------------------------------------------------------------
export type TeamFlagId = 0 | 1 | 2;

// ---------------------------------------------------------------------------
// 2D position carried by OnBeforePlayerRespawn (PORT: TVector2, Vector.pas).
// ---------------------------------------------------------------------------
export interface Vec2Like {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Event handler signatures
// ---------------------------------------------------------------------------
//
// CASCADE SEMANTICS (the part that matters):
//
//   * OnPlayerDamage — the DAMAGE-MODIFIER CASCADE. The dispatcher seeds the
//     running Damage, then walks scripts in reverse registration order; EACH
//     handler receives the running Damage and RETURNS the (possibly modified)
//     value, which becomes the input to the next handler. The final handler's
//     return is the damage actually applied.
//       PORT: ScriptDispatcher.pas:687-702
//         for I := Count-1 downto 0 do
//           Damage := Script[I].OnPlayerDamage(Victim, Shooter, Damage, Weapon);
//         Result := Damage;
//     -> Modeled here as `(...) => number`: the running damage in, the new
//        damage out. The host must thread the return value through the chain.
//
//   * OnBeforeJoinTeam — returns the target team, or -1 to reject. If a handler
//     returns a value <> -1 it becomes the team passed to the next handler; a
//     returned -1 is sticky for subsequent handlers (rejection cascades).
//       PORT: ScriptDispatcher.pas:460-482
//
//   * OnBeforePlayerRespawn — returns the spawn position; the dispatcher writes
//     it back to SpriteParts.Pos[Id] after EACH handler, so the next handler
//     observes the prior handler's chosen position.
//       PORT: ScriptDispatcher.pas:655-671
//
//   * OnRequestGame — returns a State code, chained input->output across scripts.
//       PORT: ScriptDispatcher.pas:443-458
//
//   * OnVoteMapStart / OnVoteKickStart / OnPlayerCommand / OnConsoleCommand —
//     Boolean, OR-accumulated across all scripts (any True wins). True vetoes a
//     vote / marks a command as handled.
//       PORT: ScriptDispatcher.pas:735-748, 750-763, 808-821, 823-837
//
//   * All other (procedure) events are pure broadcasts: every script's handler
//     is invoked, no value is chained.

export interface ModEventMap {
  // --- broadcasts ---

  // PORT: ScriptCore3.pas Game.OnClockTick(Ticks: Integer); fired when
  // MainTickCounter is divisible by Game.TickThreshold (ScriptCore3.pas:598-601).
  OnClockTick: (ticks: number) => void;

  // PORT: ScriptDispatcher.pas:484 OnJoinTeam(Id,Team,OldTeam,JoinGame=True) ->
  // Game.OnJoin (ScriptCore3.pas:673-706).
  OnJoin: (player: ScriptPlayer, team: number) => void;

  // PORT: ScriptDispatcher.pas:498 OnLeaveGame(Id, Kicked) -> Game.OnLeave.
  OnLeave: (player: ScriptPlayer, kicked: boolean) => void;

  // PORT: ScriptDispatcher.pas:484 OnJoinTeam with JoinGame=False (team switch).
  OnJoinTeam: (player: ScriptPlayer, team: number, oldTeam: number) => void;

  // PORT: ScriptDispatcher.pas:704 OnPlayerKill(Killer, Victim, BulletID).
  // BulletID == 100 for suicide; else Bullet[BulletID].OwnerWeapon.
  OnPlayerKill: (killer: ScriptPlayer, victim: ScriptPlayer, weapon: number) => void;

  // PORT: ScriptDispatcher.pas:585 OnFlagGrab(Id, TeamFlag, GrabbedInBase).
  OnFlagGrab: (player: ScriptPlayer, teamFlag: TeamFlagId, grabbedInBase: boolean) => void;

  // PORT: ScriptDispatcher.pas:599 OnFlagScore(Id, TeamFlag).
  OnFlagScore: (player: ScriptPlayer, teamFlag: TeamFlagId) => void;

  // PORT: ScriptDispatcher.pas:613 OnFlagReturn(Id, TeamFlag).
  OnFlagReturn: (player: ScriptPlayer, teamFlag: TeamFlagId) => void;

  // PORT: ScriptDispatcher.pas:627 OnFlagDrop(Id, TeamFlag, Thrown).
  OnFlagDrop: (player: ScriptPlayer, teamFlag: TeamFlagId, thrown: boolean) => void;

  // PORT: ScriptDispatcher.pas:641 OnKitPickup(Id, KitId).
  OnKitPickup: (player: ScriptPlayer, kitId: number) => void;

  // PORT: ScriptDispatcher.pas:718 OnWeaponChange(Id, Primary, Secondary,
  // PrimaryAmmo, SecondaryAmmo).
  OnWeaponChange: (
    player: ScriptPlayer,
    primary: number,
    secondary: number,
    primaryAmmo: number,
    secondaryAmmo: number,
  ) => void;

  // PORT: ScriptDispatcher.pas:673 OnAfterPlayerRespawn(Id) -> Player.OnAfterRespawn.
  OnAfterPlayerRespawn: (player: ScriptPlayer) => void;

  // PORT: ScriptDispatcher.pas:513 OnBeforeMapChange(Map) -> Map.OnBeforeMapChange.
  OnBeforeMapChange: (map: string) => void;

  // PORT: ScriptDispatcher.pas:527 OnAfterMapChange(Map) -> Map.OnAfterMapChange.
  OnAfterMapChange: (map: string) => void;

  // PORT: ScriptDispatcher.pas:794 OnPlayerSpeak(Id, Text) -> Player.OnSpeak.
  OnPlayerSpeak: (player: ScriptPlayer, text: string) => void;

  // PORT: ScriptDispatcher.pas:765 OnVoteMap(Id, Map).
  OnVoteMap: (player: ScriptPlayer, map: string) => void;

  // PORT: ScriptDispatcher.pas:779 OnVoteKick(Id, Victim).
  OnVoteKick: (player: ScriptPlayer, victim: ScriptPlayer) => void;

  // PORT: ScriptDispatcher.pas:542 OnAdminConnect(Ip, Port).
  OnAdminConnect: (ip: string, port: number) => void;

  // PORT: ScriptDispatcher.pas:556 OnAdminDisconnect(Ip, Port).
  OnAdminDisconnect: (ip: string, port: number) => void;

  // PORT: ScriptDispatcher.pas:570 OnAdminMessage(Ip, Port, Msg).
  OnAdminMessage: (ip: string, port: number, message: string) => void;

  // --- state-modifying (return value participates in a cascade) ---

  // THE DAMAGE-MODIFIER CASCADE.
  // PORT: ScriptDispatcher.pas:687-702. Receives the running damage; returns the
  // (possibly modified) damage that feeds the next handler / is finally applied.
  OnPlayerDamage: (victim: ScriptPlayer, shooter: ScriptPlayer, damage: number) => number;

  // PORT: ScriptDispatcher.pas:460-482. Returns target team, or -1 to reject;
  // a non-(-1) return becomes the next handler's team, -1 is sticky.
  OnBeforeJoinTeam: (player: ScriptPlayer, team: number, oldTeam: number) => number;

  // PORT: ScriptDispatcher.pas:655-671. Returns spawn position; written back to
  // SpriteParts.Pos[Id] after each handler so it chains.
  OnBeforePlayerRespawn: (player: ScriptPlayer) => Vec2Like;

  // PORT: ScriptDispatcher.pas:443-458. Returns the State code; chained.
  OnRequestGame: (
    ip: string,
    hw: string,
    port: number,
    state: number,
    forwarded: boolean,
    password: string,
  ) => number;

  // PORT: ScriptDispatcher.pas:735-748. True vetoes; OR-accumulated.
  OnVoteMapStart: (player: ScriptPlayer, map: string) => boolean;

  // PORT: ScriptDispatcher.pas:750-763. True vetoes; OR-accumulated.
  OnVoteKickStart: (player: ScriptPlayer, victim: ScriptPlayer, reason: string) => boolean;

  // PORT: ScriptDispatcher.pas:808-821. True = handled; OR-accumulated.
  OnPlayerCommand: (player: ScriptPlayer, command: string) => boolean;

  // PORT: ScriptDispatcher.pas:823-837. True = handled; OR-accumulated.
  OnConsoleCommand: (ip: string, port: number, command: string) => boolean;
}

// ---------------------------------------------------------------------------
// Cascade classification — lets a host generically reduce handler returns.
// ---------------------------------------------------------------------------

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

export const MOD_EVENT_CASCADE: Readonly<Record<ModEventName, ModEventCascade>> = Object.freeze({
  OnClockTick: 'broadcast',
  OnJoin: 'broadcast',
  OnLeave: 'broadcast',
  OnJoinTeam: 'broadcast',
  OnPlayerKill: 'broadcast',
  OnFlagGrab: 'broadcast',
  OnFlagScore: 'broadcast',
  OnFlagReturn: 'broadcast',
  OnFlagDrop: 'broadcast',
  OnKitPickup: 'broadcast',
  OnWeaponChange: 'broadcast',
  OnAfterPlayerRespawn: 'broadcast',
  OnBeforeMapChange: 'broadcast',
  OnAfterMapChange: 'broadcast',
  OnPlayerSpeak: 'broadcast',
  OnVoteMap: 'broadcast',
  OnVoteKick: 'broadcast',
  OnAdminConnect: 'broadcast',
  OnAdminDisconnect: 'broadcast',
  OnAdminMessage: 'broadcast',
  OnPlayerDamage: 'chain',
  OnBeforeJoinTeam: 'chain',
  OnBeforePlayerRespawn: 'chain',
  OnRequestGame: 'chain',
  OnVoteMapStart: 'or',
  OnVoteKickStart: 'or',
  OnPlayerCommand: 'or',
  OnConsoleCommand: 'or',
});

/** The complete set of mod event names (handy for host registration loops). */
export const MOD_EVENT_NAMES: readonly ModEventName[] = Object.freeze(
  Object.keys(MOD_EVENT_CASCADE) as ModEventName[],
);

/** A handler bound to a specific event. */
export type ModEventHandler<E extends ModEventName> = ModEventMap[E];
