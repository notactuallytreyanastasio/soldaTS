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
import { createCuadrillaEngine } from './cuadrilla';
import { createOrcaEngine } from './orca';
import { createNeuralEngine } from './neural';
import { createAnglerEngine } from './angler';
import { createDiscipleEngine } from './disciple';
import { createProdigyEngine } from './prodigy';

registerEngine('classic', createClassicEngine);
registerEngine('pilot', createPilotEngine);
registerEngine('reaper', createReaperEngine);
registerEngine('matador', createMatadorEngine);
registerEngine('kestrel', createKestrelEngine);
registerEngine('wolf', createWolfEngine);
registerEngine('plover', createPloverEngine);
registerEngine('hydra', createHydraEngine);
registerEngine('shrike', createShrikeEngine);
registerEngine('cuadrilla', createCuadrillaEngine);
registerEngine('orca', createOrcaEngine);
registerEngine('neural', createNeuralEngine);
registerEngine('angler', createAnglerEngine);
registerEngine('disciple', createDiscipleEngine);
registerEngine('prodigy', createProdigyEngine);

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
export { CUADRILLA_DEFAULTS, type CuadrillaConfig } from './cuadrilla';
export { ORCA_DEFAULTS, type OrcaConfig } from './orca';
export {
  NEURAL_DEFAULTS,
  NEURAL_SHIPPED_NET,
  NeuralPolicy,
  createNeuralEngineWithWeights,
  type NeuralConfig,
  type NeuralNet,
} from './neural';
export { ANGLER_DEFAULTS, type AnglerConfig } from './angler';
export { DISCIPLE_DEFAULTS, type DiscipleConfig } from './disciple';
export { PRODIGY_DEFAULTS, type ProdigyConfig } from './prodigy';
