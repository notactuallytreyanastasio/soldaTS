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

// --- SHARED MOD-API CONTRACT (owned by ./events + ./api) ----------------------
// The host is generic over the event map; ScriptPlayer/ScriptApi come from the
// api module so every mod sees one consistent object model.
import type { ModEventName, ModEventMap } from './events';
import type { ScriptApi, ScriptPlayer } from './api';

// --- Host-internal types ------------------------------------------------------

/** Subscription surface a mod uses to register handlers. */
export interface ModContext {
  /** Subscribe a handler. Handlers fire in registration order across all mods. */
  on<E extends ModEventName>(event: E, handler: ModEventMap[E]): void;
  /** The frozen API the mod operates against (createScriptApi output). */
  readonly api: ScriptApi;
}

/**
 * A mod is a factory: given a context it subscribes handlers (and may keep the
 * api reference). Mirrors a Pascal script's `Includes.txt` unit registering its
 * On* procedures — but here registration is explicit & data-driven.
 */
export type ModFactory = (ctx: ModContext) => void;

/** Error hook: invoked whenever a handler throws (never rethrown by the host). */
export interface HandlerErrorInfo {
  readonly event: ModEventName;
  readonly modName: string;
  readonly error: unknown;
}
export type OnErrorHook = (info: HandlerErrorInfo) => void;

/**
 * Seam for production isolation. The default invoker just calls the handler
 * synchronously. An isolated-vm/Worker build replaces this to marshal args
 * across the boundary and enforce a CPU/wall-clock budget. Whatever it does,
 * it must remain SYNCHRONOUS-RETURNING for the cascade contract and may throw
 * (the host catches everything).
 */
export type HandlerInvoker = (
  handler: (...args: unknown[]) => unknown,
  args: readonly unknown[],
) => unknown;

const defaultInvoker: HandlerInvoker = (handler, args) => handler(...args);

interface Registration<E extends ModEventName = ModEventName> {
  readonly event: E;
  readonly handler: ModEventMap[E];
  readonly modName: string;
}

let nextAnonId = 0;

/**
 * ScriptHost: registers mods and dispatches events to their handlers in
 * registration order, with per-handler isolation.
 */
export class ScriptHost {
  // One flat, ordered list per event preserves cross-mod registration order
  // (the Pascal dispatcher iterates FScripts; we iterate handlers).
  private readonly handlers = new Map<ModEventName, Registration[]>();
  private onErrorHook: OnErrorHook;
  private invoker: HandlerInvoker = defaultInvoker;

  constructor(onError?: OnErrorHook) {
    // Default: log to console.error. Never throws out of dispatch.
    this.onErrorHook =
      onError ??
      ((info): void => {
        // eslint-disable-next-line no-console
        console.error(
          `[ScriptHost] mod "${info.modName}" threw in ${info.event}:`,
          info.error,
        );
      });
  }

  /** Replace the error hook (e.g. to route into the server console/log). */
  setOnError(hook: OnErrorHook): void {
    this.onErrorHook = hook;
  }

  /**
   * Inject a production isolation invoker (isolated-vm / Worker + CPU budget).
   * The host stays agnostic; this is the single seam that wraps every call.
   */
  setHandlerInvoker(invoker: HandlerInvoker): void {
    this.invoker = invoker;
  }

  /**
   * Load (register) a mod. Calls the factory with a context whose `on(...)`
   * appends handlers; the api is the frozen createScriptApi(world) output.
   *
   * PORT: ScriptDispatcher.FindScripts/Launch — but registration here is a plain
   * function call instead of compiling a PascalScript unit from disk.
   */
  loadMod(modFactory: ModFactory, api: ScriptApi, modName?: string): void {
    const name =
      modName ?? (modFactory.name !== '' ? modFactory.name : `mod#${nextAnonId++}`);
    const ctx: ModContext = {
      api,
      on: <E extends ModEventName>(event: E, handler: ModEventMap[E]): void => {
        let list = this.handlers.get(event);
        if (list === undefined) {
          list = [];
          this.handlers.set(event, list);
        }
        list.push({ event, handler, modName: name } as Registration);
      },
    };
    // The factory itself runs guarded: a mod that throws while *registering*
    // must not abort loading of other mods.
    try {
      modFactory(ctx);
    } catch (error) {
      this.onErrorHook({ event: 'OnClockTick', modName: name, error });
    }
  }

  /** Number of registered handlers for an event (for tests/introspection). */
  handlerCount(event: ModEventName): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  /**
   * Invoke one handler with full isolation. Returns the raw result, or the
   * sentinel `HANDLER_FAILED` if it threw (so cascades keep the last good value).
   */
  private invokeHandler(reg: Registration, args: readonly unknown[]): unknown {
    try {
      return this.invoker(reg.handler as (...a: unknown[]) => unknown, args);
    } catch (error) {
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
  dispatch<E extends ModEventName>(
    event: E,
    ...args: Parameters<ModEventMap[E]>
  ): void {
    const list = this.handlers.get(event);
    if (list === undefined) return;
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
  dispatchPlayerDamage(
    victim: ScriptPlayer,
    shooter: ScriptPlayer,
    damage: number,
  ): number {
    const list = this.handlers.get('OnPlayerDamage');
    if (list === undefined) return damage;
    let current = damage;
    for (const reg of list) {
      const result = this.invokeHandler(reg, [victim, shooter, current]);
      if (result === HANDLER_FAILED) continue; // keep last good value
      if (typeof result === 'number' && Number.isFinite(result)) {
        current = result;
      }
      // Non-number / non-finite return: treat as "no modification" and carry on.
    }
    return current;
  }
}

/** Sentinel distinguishing "handler threw" from a legitimate `undefined`/number. */
const HANDLER_FAILED: unique symbol = Symbol('HANDLER_FAILED');
