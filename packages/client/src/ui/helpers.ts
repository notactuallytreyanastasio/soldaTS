// Pure HUD helpers — formatting and layout math extracted from the pixi glue
// so they can be unit-tested without a renderer.
//
// PORT: client/InterfaceGraphics.pas — RenderInterface / RenderBar. OpenSoldat
// lays the interface out against a 640x480 design space and scales by `_iscala`
// (the screen / design ratio). Bars are drawn by clipping a texture to a
// fraction of its width/height; that fraction is the value/max ratio clamped to
// [0,1] (RenderBar, InterfaceGraphics.pas:418 `p := Max(0, Min(1, p))`).

// PORT: client/InterfaceGraphics.pas — the default interface coordinates are
// authored against this design resolution (e.g. HealthBar_X := 45, JetBar_X :=
// 520, Ping_X := 600 all assume a 640-wide canvas).
export const DESIGN_WIDTH = 640 as const;
export const DESIGN_HEIGHT = 480 as const;

// PORT: combat/damage.ts STARTHEALTH (Constants.pas:75) — full-health value the
// health bar is normalised against. Re-declared here to keep helpers pure and
// free of a sim import; kept in sync with @soldat/sim STARTHEALTH = 150.
export const START_HEALTH = 150 as const;

/**
 * Fill ratio for a bar, clamped to [0,1].
 *
 * PORT: InterfaceGraphics.pas:418 — `p := Max(0, Min(1, p))` where p is the
 * value/max ratio (e.g. SpriteMe.Health / STARTHEALTH, JetsCountReal /
 * Map.StartJet, AmmoCount / Weapon.Ammo).
 */
export function barFillRatio(value: number, max: number): number {
  if (!(max > 0)) return 0;
  const p = value / max;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}

/**
 * Uniform design->screen scale. OpenSoldat keeps the interface a fixed aspect
 * and scales it to the viewport; we take the smaller axis ratio so nothing
 * overflows, mirroring how `_iscala` is derived from the render size.
 *
 * PORT: InterfaceGraphics.pas — `_iscala` (interface scale) applied as
 * `coord * _iscala.x|y`.
 */
export function interfaceScale(width: number, height: number): number {
  const sx = width / DESIGN_WIDTH;
  const sy = height / DESIGN_HEIGHT;
  return Math.min(sx, sy);
}

/**
 * Format the personal-score line shown bottom-centre.
 *
 * PORT: InterfaceGraphics.pas:982-993 — when the local player leads, the gap to
 * the runner-up is shown with an explicit '+' sign; otherwise the (signed) gap
 * to the leader is shown in parentheses.
 */
export function formatScore(kills: number, leading: boolean, gap: number): string {
  if (leading) {
    const sign = gap > 0 ? '+' : '';
    return `${kills} (${sign}${gap})`;
  }
  return `${kills} (${gap})`;
}

/**
 * Format a rank line "pos/total".
 *
 * PORT: InterfaceGraphics.pas:975 — `IntToStr(Pos) + '/' + IntToStr(PlayersNum
 * - SpectatorsNum)`.
 */
export function formatRank(pos: number, total: number): string {
  return `${pos}/${total}`;
}

/**
 * Format a team-vs-team score line, e.g. "3 : 2".
 *
 * Layout intent only (no single .pas line — team scores are drawn from the
 * scoreboard); kept here so the glue has a tested formatter.
 */
export function formatTeamScore(alpha: number, bravo: number): string {
  return `${alpha} : ${bravo}`;
}

/**
 * Format the ammo readout. SPAS-style weapons and reload states aside, the HUD
 * prints the raw current magazine count.
 *
 * PORT: InterfaceGraphics.pas:930-932 — `IntToStr(Me.Weapon.AmmoCount)`.
 */
export function formatAmmo(ammo: number): string {
  return `${ammo}`;
}
