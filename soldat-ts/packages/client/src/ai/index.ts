// Bot-AI engine registry bootstrap: importing this module registers the
// built-in engines. Add new brains here and they become selectable via
// ?ai=<id> and watchable head-to-head via ?duel=<a>,<b>.

import { registerEngine } from './engine';
import { createClassicEngine } from './classic';
import { createPilotEngine } from './pilot';
import { createReaperEngine } from './reaper';

registerEngine('classic', createClassicEngine);
registerEngine('pilot', createPilotEngine);
registerEngine('reaper', createReaperEngine);

export * from './engine';
