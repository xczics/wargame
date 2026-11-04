// The starter-army plugin's line on a barracks' card, from the number its server plugin gives (`buildings.addEffects`):
// how much faster training is there (none at level 1).
import { amount } from '../../../src/shared/format';
import type { BuildingEffectPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('starter-army');

// `faster`: % of the time taken off; shown as the speed it gives (time × 0.95 = speed +5.3%).
const words: BuildingEffectPart = ({ values }) =>
	values.faster > 0 && values.faster < 100 ? [text('Training speed +{0}%', { 0: amount((100 / (100 - values.faster) - 1) * 100, 1) })] : [];

// At the buildings client plugin's extension point (its id is the server plugin whose numbers these are).
export const parts = [defineClientPart<BuildingEffectPart>({ point: 'buildings.effects', id: 'starter-army', part: words })];
