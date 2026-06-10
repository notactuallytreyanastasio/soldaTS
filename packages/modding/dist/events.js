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
export const MOD_EVENT_CASCADE = Object.freeze({
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
export const MOD_EVENT_NAMES = Object.freeze(Object.keys(MOD_EVENT_CASCADE));
//# sourceMappingURL=events.js.map