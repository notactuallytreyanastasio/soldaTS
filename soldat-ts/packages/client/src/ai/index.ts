// Bot-AI engine registry bootstrap: importing this module registers the
// built-in engines. Add new brains here and they become selectable via
// ?ai=<id> and watchable head-to-head via ?duel=<a>,<b>.

import { registerEngine } from './engine';
import { createClassicEngine } from './classic';
import { createPilotEngine } from './pilot';

registerEngine('classic', createClassicEngine);
registerEngine('pilot', createPilotEngine);

export * from './engine';
