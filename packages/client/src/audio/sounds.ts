// SoundName union + asset manifest for the SFX set.
//
// PORT: client/Sound.pas:200-365 — the SAMPLE_FILES array (the canonical 163
// OpenSoldat sound samples, 1-based). Names here mirror the Pascal SFX_*
// constants in shared/Constants.pas:422-583, lower-cased and de-prefixed.
//
// ASSET LICENSING NOTE: the actual .wav files are NOT bundled with this
// rewrite. OpenSoldat's sound assets ship under the original game's content
// license, not the GPL covering the engine, so they must be USER-SUPPLIED:
// dropped into the served `/sfx/` directory at runtime. The manifest below
// only records the *paths* the AudioEngine will fetch; a missing file simply
// fails to load and the corresponding sound becomes a silent no-op.

/**
 * The set of playable sound effects. Mirrors the OpenSoldat SFX_* constant set
 * (shared/Constants.pas) one-to-one. Index 4 ('empty.wav') is intentionally
 * absent — it is "no longer used" per client/Sound.pas:209.
 */
export type SoundName =
  | 'ak74-fire'
  | 'rocketz'
  | 'ak74-reload'
  | 'm249-fire'
  | 'ruger77-fire'
  | 'ruger77-reload'
  | 'm249-reload'
  | 'mp5-fire'
  | 'mp5-reload'
  | 'spas12-fire'
  | 'spas12-reload'
  | 'standup'
  | 'fall'
  | 'spawn'
  | 'm79-fire'
  | 'm79-explosion'
  | 'm79-reload'
  | 'grenade-throw'
  | 'grenade-explosion'
  | 'grenade-bounce'
  | 'bryzg'
  | 'infiltmus'
  | 'headchop'
  | 'explosion-erg'
  | 'water-step'
  | 'bulletby'
  | 'bodyfall'
  | 'deserteagle-fire'
  | 'deserteagle-reload'
  | 'steyraug-fire'
  | 'steyraug-reload'
  | 'barretm82-fire'
  | 'barretm82-reload'
  | 'minigun-fire'
  | 'minigun-reload'
  | 'minigun-start'
  | 'minigun-end'
  | 'pickupgun'
  | 'capture'
  | 'colt1911-fire'
  | 'colt1911-reload'
  | 'changeweapon'
  | 'shell'
  | 'shell2'
  | 'dead-hit'
  | 'throwgun'
  | 'bow-fire'
  | 'takebow'
  | 'takemedikit'
  | 'wermusic'
  | 'ts'
  | 'ctf'
  | 'berserker'
  | 'godflame'
  | 'flamer'
  | 'predator'
  | 'killberserk'
  | 'vesthit'
  | 'burn'
  | 'vesttake'
  | 'clustergrenade'
  | 'cluster-explosion'
  | 'grenade-pullout'
  | 'spit'
  | 'stuff'
  | 'smoke'
  | 'match'
  | 'roar'
  | 'step'
  | 'step2'
  | 'step3'
  | 'step4'
  | 'hum'
  | 'ric'
  | 'ric2'
  | 'ric3'
  | 'ric4'
  | 'dist-m79'
  | 'dist-grenade'
  | 'dist-gun1'
  | 'dist-gun2'
  | 'dist-gun3'
  | 'dist-gun4'
  | 'death'
  | 'death2'
  | 'death3'
  | 'crouch-move'
  | 'hit-arg'
  | 'hit-arg2'
  | 'hit-arg3'
  | 'goprone'
  | 'roll'
  | 'fall-hard'
  | 'onfire'
  | 'firecrack'
  | 'scope'
  | 'scopeback'
  | 'playerdeath'
  | 'changespin'
  | 'arg'
  | 'lava'
  | 'regenerate'
  | 'prone-move'
  | 'jump'
  | 'crouch'
  | 'crouch-movel'
  | 'step5'
  | 'step6'
  | 'step7'
  | 'step8'
  | 'stop'
  | 'bulletby2'
  | 'bulletby3'
  | 'bulletby4'
  | 'bulletby5'
  | 'weaponhit'
  | 'clipfall'
  | 'bonecrack'
  | 'gaugeshell'
  | 'colliderhit'
  | 'kit-fall'
  | 'kit-fall2'
  | 'flag'
  | 'flag2'
  | 'takegun'
  | 'infilt-point'
  | 'menuclick'
  | 'knife'
  | 'slash'
  | 'chainsaw-d'
  | 'chainsaw-m'
  | 'chainsaw-r'
  | 'piss'
  | 'law'
  | 'chainsaw-o'
  | 'm2fire'
  | 'm2explode'
  | 'm2overheat'
  | 'signal'
  | 'm2use'
  | 'scoperun'
  | 'mercy'
  | 'ric5'
  | 'ric6'
  | 'ric7'
  | 'law-start'
  | 'law-end'
  | 'boomheadshot'
  | 'snapshot'
  | 'radio-efcup'
  | 'radio-efcmid'
  | 'radio-efcdown'
  | 'radio-ffcup'
  | 'radio-ffcmid'
  | 'radio-ffcdown'
  | 'radio-esup'
  | 'radio-esmid'
  | 'radio-esdown'
  | 'bounce'
  | 'sfx_rain'
  | 'sfx_snow'
  | 'sfx_wind';

/**
 * Looping sounds. PORT: client/Sound.pas:451-454 — SFX_ROCKETZ, SFX_CHAINSAW_R
 * and SFX_FLAMER are played with AL_LOOPING set; everything else is one-shot.
 */
export const LOOPING_SOUNDS: ReadonlySet<SoundName> = new Set<SoundName>([
  'rocketz',
  'chainsaw-r',
  'flamer',
]);

/**
 * Maps each SoundName to the URL the AudioEngine will fetch its AudioBuffer
 * from. Paths are relative to the served root and mirror the original on-disk
 * layout (`sfx/<file>.wav`, including the `radio/` subdir).
 *
 * PORT: client/Sound.pas:370 — `SfxPath := ModDir + 'sfx/'`.
 */
export const SOUND_MANIFEST: Readonly<Record<SoundName, string>> = {
  'ak74-fire': '/sfx/ak74-fire.wav',
  rocketz: '/sfx/rocketz.wav',
  'ak74-reload': '/sfx/ak74-reload.wav',
  'm249-fire': '/sfx/m249-fire.wav',
  'ruger77-fire': '/sfx/ruger77-fire.wav',
  'ruger77-reload': '/sfx/ruger77-reload.wav',
  'm249-reload': '/sfx/m249-reload.wav',
  'mp5-fire': '/sfx/mp5-fire.wav',
  'mp5-reload': '/sfx/mp5-reload.wav',
  'spas12-fire': '/sfx/spas12-fire.wav',
  'spas12-reload': '/sfx/spas12-reload.wav',
  standup: '/sfx/standup.wav',
  fall: '/sfx/fall.wav',
  spawn: '/sfx/spawn.wav',
  'm79-fire': '/sfx/m79-fire.wav',
  'm79-explosion': '/sfx/m79-explosion.wav',
  'm79-reload': '/sfx/m79-reload.wav',
  'grenade-throw': '/sfx/grenade-throw.wav',
  'grenade-explosion': '/sfx/grenade-explosion.wav',
  'grenade-bounce': '/sfx/grenade-bounce.wav',
  bryzg: '/sfx/bryzg.wav',
  infiltmus: '/sfx/infiltmus.wav',
  headchop: '/sfx/headchop.wav',
  'explosion-erg': '/sfx/explosion-erg.wav',
  'water-step': '/sfx/water-step.wav',
  bulletby: '/sfx/bulletby.wav',
  bodyfall: '/sfx/bodyfall.wav',
  'deserteagle-fire': '/sfx/deserteagle-fire.wav',
  'deserteagle-reload': '/sfx/deserteagle-reload.wav',
  'steyraug-fire': '/sfx/steyraug-fire.wav',
  'steyraug-reload': '/sfx/steyraug-reload.wav',
  'barretm82-fire': '/sfx/barretm82-fire.wav',
  'barretm82-reload': '/sfx/barretm82-reload.wav',
  'minigun-fire': '/sfx/minigun-fire.wav',
  'minigun-reload': '/sfx/minigun-reload.wav',
  'minigun-start': '/sfx/minigun-start.wav',
  'minigun-end': '/sfx/minigun-end.wav',
  pickupgun: '/sfx/pickupgun.wav',
  capture: '/sfx/capture.wav',
  'colt1911-fire': '/sfx/colt1911-fire.wav',
  'colt1911-reload': '/sfx/colt1911-reload.wav',
  changeweapon: '/sfx/changeweapon.wav',
  shell: '/sfx/shell.wav',
  shell2: '/sfx/shell2.wav',
  'dead-hit': '/sfx/dead-hit.wav',
  throwgun: '/sfx/throwgun.wav',
  'bow-fire': '/sfx/bow-fire.wav',
  takebow: '/sfx/takebow.wav',
  takemedikit: '/sfx/takemedikit.wav',
  wermusic: '/sfx/wermusic.wav',
  ts: '/sfx/ts.wav',
  ctf: '/sfx/ctf.wav',
  berserker: '/sfx/berserker.wav',
  godflame: '/sfx/godflame.wav',
  flamer: '/sfx/flamer.wav',
  predator: '/sfx/predator.wav',
  killberserk: '/sfx/killberserk.wav',
  vesthit: '/sfx/vesthit.wav',
  burn: '/sfx/burn.wav',
  vesttake: '/sfx/vesttake.wav',
  clustergrenade: '/sfx/clustergrenade.wav',
  'cluster-explosion': '/sfx/cluster-explosion.wav',
  'grenade-pullout': '/sfx/grenade-pullout.wav',
  spit: '/sfx/spit.wav',
  stuff: '/sfx/stuff.wav',
  smoke: '/sfx/smoke.wav',
  match: '/sfx/match.wav',
  roar: '/sfx/roar.wav',
  step: '/sfx/step.wav',
  step2: '/sfx/step2.wav',
  step3: '/sfx/step3.wav',
  step4: '/sfx/step4.wav',
  hum: '/sfx/hum.wav',
  ric: '/sfx/ric.wav',
  ric2: '/sfx/ric2.wav',
  ric3: '/sfx/ric3.wav',
  ric4: '/sfx/ric4.wav',
  'dist-m79': '/sfx/dist-m79.wav',
  'dist-grenade': '/sfx/dist-grenade.wav',
  'dist-gun1': '/sfx/dist-gun1.wav',
  'dist-gun2': '/sfx/dist-gun2.wav',
  'dist-gun3': '/sfx/dist-gun3.wav',
  'dist-gun4': '/sfx/dist-gun4.wav',
  death: '/sfx/death.wav',
  death2: '/sfx/death2.wav',
  death3: '/sfx/death3.wav',
  'crouch-move': '/sfx/crouch-move.wav',
  'hit-arg': '/sfx/hit-arg.wav',
  'hit-arg2': '/sfx/hit-arg2.wav',
  'hit-arg3': '/sfx/hit-arg3.wav',
  goprone: '/sfx/goprone.wav',
  roll: '/sfx/roll.wav',
  'fall-hard': '/sfx/fall-hard.wav',
  onfire: '/sfx/onfire.wav',
  firecrack: '/sfx/firecrack.wav',
  scope: '/sfx/scope.wav',
  scopeback: '/sfx/scopeback.wav',
  playerdeath: '/sfx/playerdeath.wav',
  changespin: '/sfx/changespin.wav',
  arg: '/sfx/arg.wav',
  lava: '/sfx/lava.wav',
  regenerate: '/sfx/regenerate.wav',
  'prone-move': '/sfx/prone-move.wav',
  jump: '/sfx/jump.wav',
  crouch: '/sfx/crouch.wav',
  'crouch-movel': '/sfx/crouch-movel.wav',
  step5: '/sfx/step5.wav',
  step6: '/sfx/step6.wav',
  step7: '/sfx/step7.wav',
  step8: '/sfx/step8.wav',
  stop: '/sfx/stop.wav',
  bulletby2: '/sfx/bulletby2.wav',
  bulletby3: '/sfx/bulletby3.wav',
  bulletby4: '/sfx/bulletby4.wav',
  bulletby5: '/sfx/bulletby5.wav',
  weaponhit: '/sfx/weaponhit.wav',
  clipfall: '/sfx/clipfall.wav',
  bonecrack: '/sfx/bonecrack.wav',
  gaugeshell: '/sfx/gaugeshell.wav',
  colliderhit: '/sfx/colliderhit.wav',
  'kit-fall': '/sfx/kit-fall.wav',
  'kit-fall2': '/sfx/kit-fall2.wav',
  flag: '/sfx/flag.wav',
  flag2: '/sfx/flag2.wav',
  takegun: '/sfx/takegun.wav',
  'infilt-point': '/sfx/infilt-point.wav',
  menuclick: '/sfx/menuclick.wav',
  knife: '/sfx/knife.wav',
  slash: '/sfx/slash.wav',
  'chainsaw-d': '/sfx/chainsaw-d.wav',
  'chainsaw-m': '/sfx/chainsaw-m.wav',
  'chainsaw-r': '/sfx/chainsaw-r.wav',
  piss: '/sfx/piss.wav',
  law: '/sfx/law.wav',
  'chainsaw-o': '/sfx/chainsaw-o.wav',
  m2fire: '/sfx/m2fire.wav',
  m2explode: '/sfx/m2explode.wav',
  m2overheat: '/sfx/m2overheat.wav',
  signal: '/sfx/signal.wav',
  m2use: '/sfx/m2use.wav',
  scoperun: '/sfx/scoperun.wav',
  mercy: '/sfx/mercy.wav',
  ric5: '/sfx/ric5.wav',
  ric6: '/sfx/ric6.wav',
  ric7: '/sfx/ric7.wav',
  'law-start': '/sfx/law-start.wav',
  'law-end': '/sfx/law-end.wav',
  boomheadshot: '/sfx/boomheadshot.wav',
  snapshot: '/sfx/snapshot.wav',
  'radio-efcup': '/sfx/radio/efcup.wav',
  'radio-efcmid': '/sfx/radio/efcmid.wav',
  'radio-efcdown': '/sfx/radio/efcdown.wav',
  'radio-ffcup': '/sfx/radio/ffcup.wav',
  'radio-ffcmid': '/sfx/radio/ffcmid.wav',
  'radio-ffcdown': '/sfx/radio/ffcdown.wav',
  'radio-esup': '/sfx/radio/esup.wav',
  'radio-esmid': '/sfx/radio/esmid.wav',
  'radio-esdown': '/sfx/radio/esdown.wav',
  bounce: '/sfx/bounce.wav',
  sfx_rain: '/sfx/sfx_rain.wav',
  sfx_snow: '/sfx/sfx_snow.wav',
  sfx_wind: '/sfx/sfx_wind.wav',
};

/** All sound names, in canonical order. */
export const ALL_SOUND_NAMES: readonly SoundName[] = Object.keys(
  SOUND_MANIFEST,
) as SoundName[];
