// Bot-AI engine registry bootstrap: importing this module registers the
// built-in engines. Add new brains here and they become selectable via
// ?ai=<id> and watchable head-to-head via ?duel=<a>,<b>.

import { registerEngine } from './engine';
import { createClassicEngine } from './classic';
import { createPilotEngine } from './pilot';
import { createReaperEngine } from './reaper';
import { createMatadorEngine } from './matador';
import { createKestrelEngine } from './kestrel';
import { createWolfEngine } from './wolf';
import { createPloverEngine } from './plover';
import { createHydraEngine } from './hydra';
import { createShrikeEngine } from './shrike';

registerEngine('classic', createClassicEngine);
registerEngine('pilot', createPilotEngine);
registerEngine('reaper', createReaperEngine);
registerEngine('matador', createMatadorEngine);
registerEngine('kestrel', createKestrelEngine);
registerEngine('wolf', createWolfEngine);
registerEngine('plover', createPloverEngine);
registerEngine('hydra', createHydraEngine);
registerEngine('shrike', createShrikeEngine);

export * from './engine';
export { CLASSIC_DEFAULTS, type ClassicConfig } from './classic';
export { PILOT_DEFAULTS, type PilotConfig } from './pilot';
export { REAPER_DEFAULTS, type ReaperConfig } from './reaper';
export { MATADOR_DEFAULTS, type MatadorConfig } from './matador';
export { KESTREL_DEFAULTS, type KestrelConfig } from './kestrel';
export { WOLF_DEFAULTS, type WolfConfig } from './wolf';
export { PLOVER_DEFAULTS, type PloverConfig } from './plover';
export { HYDRA_DEFAULTS, type HydraConfig } from './hydra';
export { SHRIKE_DEFAULTS, type ShrikeConfig } from './shrike';
