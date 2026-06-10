/**
 * Entity record types — faithful TS port of the OpenSoldat world-state objects.
 *
 * Mirrors the Pascal `object`/`record` declarations field-for-field (same names,
 * same order where practical). All `Single` fields become `number`; positions are
 * expressed with the shared {@link Vec2} type where the Pascal uses `TVector2`.
 *
 * Indexing convention (see docs/rewrite-reference/global-state-and-caps.md §3):
 * these records live in 1-based fixed arrays with index 0 as an unused sentinel.
 *
 * Client-only / render-only fields and the embedded `ParticleSystem` skeletons
 * are intentionally OMITTED here (noted per-record); the physics skeleton lives
 * in the particle subsystem, not in these records. AI brain data (TBotData) and
 * the embedded TPlayer object are likewise omitted — they are not part of the
 * minimal simulation record model this module describes.
 */
export {};
//# sourceMappingURL=types.js.map