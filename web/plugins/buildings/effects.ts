// What other plugins say a building does (a wall's defence, a hidden store's protection): the server sends their numbers
// by the plugin that gives them (`buildings.addEffects`, `BuildingEffectData`), and each plugin's client plugin words
// its own at the extension point "buildings.effects" (`defineClientPart`), so buildings knows nothing of walls.
import type { BuildingEffectData, BuildingEffectPart } from '../../../src/shared/api';
import type { UiText } from '../../../src/shared/ui';

export const EFFECTS_POINT = 'buildings.effects';

/** The lines for a building at `level`, in the order the server's plugins gave them (none worded: nothing shown). */
export const effectLines = (
	parts: ReadonlyMap<string, BuildingEffectPart> | undefined,
	building: string,
	level: number,
	data: BuildingEffectData | undefined,
): UiText[] => Object.entries(data ?? {}).flatMap(([owner, values]) => parts?.get(owner)?.({ building, level, values }) ?? []);
