// Research's part of a stat's percent (extension point "stats.known"), from what the browser holds: the tech levels the
// Tech page synced and the static tree (the same sum as the server's: per level, a milestone once). Nothing until the
// Tech page has been open (user 2026-11-05: "玩家如果点了科技页，那前端不就有科技值了吗？复用不就好了？"). Pure.
import type { ResearchState, StatPercentPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';
import type { ResearchCatalog } from '../../../src/shared/research';
import type { TreeData } from '../../../src/shared/ui';

const text = uiTexts('research');

const known: StatPercentPart = (stat, get) => {
	const state = get.latest?.<ResearchState | null>('research.state');
	const catalog = get.static<TreeData>('research.techs')?.data as ResearchCatalog | undefined;
	if (!state || !catalog) return undefined;
	let percent = 0;
	for (const tech of [...catalog.techs, ...(state.own ?? [])]) {
		const level = state.levels[tech.id] ?? 0;
		if (level)
			for (const e of tech.effects)
				if (e.target === stat && e.percent && !e.family) percent += e.atLevel ? (level >= e.atLevel ? e.value : 0) : e.value * level;
	}
	return { percent, source: text('Techs') };
};

export const parts = [defineClientPart<StatPercentPart>({ point: 'stats.known', id: 'research', part: known })];
