// @soldat/modding — ScriptHost: mod registration + event dispatch + isolation.
//
// PORT: server/scriptcore/ScriptDispatcher.pas (load/compile/dispatch model) and
//       server/scriptcore/ScriptCore.pas (per-script event invocation + crash handling).
//
// WHY A REWRITE (documented divergences from the Pascal model):
//
//  1. SINGLE-LOCK MAIN-THREAD DISPATCH (the bug we FIX).
//     TScriptDispatcher serialises every event behind one critical section
//     (ScriptDispatcher.pas:214–224 DoLock/DoUnlock; acquired at the top of every
//     On* handler, released in `finally`). On the main thread the lock is skipped
//     (`if GetThreadID <> MainThreadID`), so a handler that throws an *uncaught*
//     Pascal exception, infinite-loops, or deadlocks while holding state stalls the
//     entire server tick. PascalScript's own per-call try/except (ScriptCore.pas:234–273)
//     only catches *script-level* exceptions and, worse, escalates to a full server
//     `shutdown`/`recompile` after 10 errors (ScriptCore.pas:247–270) — one bad mod can
//     take the server down. There is no per-tick CPU budget; a runaway loop hangs forever.
//
//  2. OUR FIX (in this file, isolation-agnostic):
//     - Every handler runs inside its own try/catch. A throwing handler is logged via the
//       `onError` hook and SKIPPED; later handlers and the dispatch itself ALWAYS survive.
//     - One mod can never break another: handlers are isolated per-invocation; a thrown
//       error never propagates out of `dispatch`.
//     - Cascade events (OnPlayerDamage, OnBeforeJoinTeam, OnRequestGame, …) thread the
//       (possibly-modified) return value through the chain — but if a handler throws, we
//       keep the LAST good value and continue (the Pascal code would have aborted the
//       whole pass).
//
//  3. WHERE PRODUCTION ISOLATION PLUGS IN.
//     This host is deliberately isolation-AGNOSTIC: it calls plain JS functions. In
//     production each mod's handlers would instead be marshalled into an isolated-vm
//     Isolate or a Worker, and `invokeHandler` below would (a) post the args across the
//     boundary, (b) enforce a per-dispatch CPU/wall-clock budget, and (c) reclaim the
//     isolate on timeout — turning a "hung handler" from a server stall into a logged,
//     skipped handler. The try/catch + onError seam here is exactly the seam that wraps.
//     See `HandlerInvoker` / `setHandlerInvoker` for the injection point.
const defaultInvoker = (handler, args) => handler(...args);
let nextAnonId = 0;
/**
 * ScriptHost: registers mods and dispatches events to their handlers in
 * registration order, with per-handler isolation.
 */
export class ScriptHost {
    // One flat, ordered list per event preserves cross-mod registration order
    // (the Pascal dispatcher iterates FScripts; we iterate handlers).
    handlers = new Map();
    onErrorHook;
    invoker = defaultInvoker;
    constructor(onError) {
        // Default: log to console.error. Never throws out of dispatch.
        this.onErrorHook =
            onError ??
                ((info) => {
                    // eslint-disable-next-line no-console
                    console.error(`[ScriptHost] mod "${info.modName}" threw in ${info.event}:`, info.error);
                });
    }
    /** Replace the error hook (e.g. to route into the server console/log). */
    setOnError(hook) {
        this.onErrorHook = hook;
    }
    /**
     * Inject a production isolation invoker (isolated-vm / Worker + CPU budget).
     * The host stays agnostic; this is the single seam that wraps every call.
     */
    setHandlerInvoker(invoker) {
        this.invoker = invoker;
    }
    /**
     * Load (register) a mod. Calls the factory with a context whose `on(...)`
     * appends handlers; the api is the frozen createScriptApi(world) output.
     *
     * PORT: ScriptDispatcher.FindScripts/Launch — but registration here is a plain
     * function call instead of compiling a PascalScript unit from disk.
     */
    loadMod(modFactory, api, modName) {
        const name = modName ?? (modFactory.name !== '' ? modFactory.name : `mod#${nextAnonId++}`);
        const ctx = {
            api,
            on: (event, handler) => {
                let list = this.handlers.get(event);
                if (list === undefined) {
                    list = [];
                    this.handlers.set(event, list);
                }
                list.push({ event, handler, modName: name });
            },
        };
        // The factory itself runs guarded: a mod that throws while *registering*
        // must not abort loading of other mods.
        try {
            modFactory(ctx);
        }
        catch (error) {
            this.onErrorHook({ event: 'OnClockTick', modName: name, error });
        }
    }
    /** Number of registered handlers for an event (for tests/introspection). */
    handlerCount(event) {
        return this.handlers.get(event)?.length ?? 0;
    }
    /**
     * Invoke one handler with full isolation. Returns the raw result, or the
     * sentinel `HANDLER_FAILED` if it threw (so cascades keep the last good value).
     */
    invokeHandler(reg, args) {
        try {
            return this.invoker(reg.handler, args);
        }
        catch (error) {
            this.onErrorHook({ event: reg.event, modName: reg.modName, error });
            return HANDLER_FAILED;
        }
    }
    /**
     * Dispatch a NON-cascade (void) event to every handler in registration order.
     * A throwing handler is logged and skipped; the host always survives.
     *
     * PORT: ScriptDispatcher.pas broadcast events (OnClockTick, OnJoinTeam, …).
     */
    dispatch(event, ...args) {
        const list = this.handlers.get(event);
        if (list === undefined)
            return;
        for (const reg of list) {
            // Snapshot iteration: a handler that (mis)behaves can't reorder others.
            this.invokeHandler(reg, args);
        }
    }
    /**
     * Dispatch the OnPlayerDamage cascade. The damage value is threaded through
     * every handler in registration order; each handler's (numeric) return becomes
     * the next handler's `damage` input. A handler that throws — or returns a
     * non-finite/non-number value — is skipped and the previous good damage carries
     * forward (the Pascal dispatcher would have aborted the whole pass on a throw).
     *
     * PORT: ScriptCore.pas:387–397 + ScriptDispatcher.pas:687–701.
     */
    dispatchPlayerDamage(victim, shooter, damage) {
        const list = this.handlers.get('OnPlayerDamage');
        if (list === undefined)
            return damage;
        let current = damage;
        for (const reg of list) {
            const result = this.invokeHandler(reg, [victim, shooter, current]);
            if (result === HANDLER_FAILED)
                continue; // keep last good value
            if (typeof result === 'number' && Number.isFinite(result)) {
                current = result;
            }
            // Non-number / non-finite return: treat as "no modification" and carry on.
        }
        return current;
    }
}
/** Sentinel distinguishing "handler threw" from a legitimate `undefined`/number. */
const HANDLER_FAILED = Symbol('HANDLER_FAILED');
//# sourceMappingURL=host.js.map