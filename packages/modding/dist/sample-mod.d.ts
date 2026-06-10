import type { ModFactory } from './host.js';
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
export declare function createDoubleDamageMod(log?: SampleModLog, multiplier?: number): ModFactory;
/** A ready-to-load instance using a fresh log (exported for convenience/tests). */
export declare const sampleModLog: SampleModLog;
export declare const sampleMod: ModFactory;
//# sourceMappingURL=sample-mod.d.ts.map