import type { ModEventName, ModEventMap } from './events';
import type { ScriptApi, ScriptPlayer } from './api';
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
export type HandlerInvoker = (handler: (...args: unknown[]) => unknown, args: readonly unknown[]) => unknown;
/**
 * ScriptHost: registers mods and dispatches events to their handlers in
 * registration order, with per-handler isolation.
 */
export declare class ScriptHost {
    private readonly handlers;
    private onErrorHook;
    private invoker;
    constructor(onError?: OnErrorHook);
    /** Replace the error hook (e.g. to route into the server console/log). */
    setOnError(hook: OnErrorHook): void;
    /**
     * Inject a production isolation invoker (isolated-vm / Worker + CPU budget).
     * The host stays agnostic; this is the single seam that wraps every call.
     */
    setHandlerInvoker(invoker: HandlerInvoker): void;
    /**
     * Load (register) a mod. Calls the factory with a context whose `on(...)`
     * appends handlers; the api is the frozen createScriptApi(world) output.
     *
     * PORT: ScriptDispatcher.FindScripts/Launch — but registration here is a plain
     * function call instead of compiling a PascalScript unit from disk.
     */
    loadMod(modFactory: ModFactory, api: ScriptApi, modName?: string): void;
    /** Number of registered handlers for an event (for tests/introspection). */
    handlerCount(event: ModEventName): number;
    /**
     * Invoke one handler with full isolation. Returns the raw result, or the
     * sentinel `HANDLER_FAILED` if it threw (so cascades keep the last good value).
     */
    private invokeHandler;
    /**
     * Dispatch a NON-cascade (void) event to every handler in registration order.
     * A throwing handler is logged and skipped; the host always survives.
     *
     * PORT: ScriptDispatcher.pas broadcast events (OnClockTick, OnJoinTeam, …).
     */
    dispatch<E extends ModEventName>(event: E, ...args: Parameters<ModEventMap[E]>): void;
    /**
     * Dispatch the OnPlayerDamage cascade. The damage value is threaded through
     * every handler in registration order; each handler's (numeric) return becomes
     * the next handler's `damage` input. A handler that throws — or returns a
     * non-finite/non-number value — is skipped and the previous good damage carries
     * forward (the Pascal dispatcher would have aborted the whole pass on a throw).
     *
     * PORT: ScriptCore.pas:387–397 + ScriptDispatcher.pas:687–701.
     */
    dispatchPlayerDamage(victim: ScriptPlayer, shooter: ScriptPlayer, damage: number): number;
}
//# sourceMappingURL=host.d.ts.map