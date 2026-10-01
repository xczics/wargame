// How tech cards describe a tech, shared by the tree and the institute.
import type { TechInfo } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import type { Game } from '../../core/game';

export function techText(game: Game) {
	const families = new Map((game.meta.battleFamilies ?? []).map((f) => [f.id, f.name]));
	const buildings = new Map((game.meta.buildings ?? []).map((b) => [b.id, b.name]));
	return {
		/** "Attack +3% (Archers)", "Training time −5%", "Hero limit +1" — per level. */
		effect(e: TechInfo['effects'][number]) {
			const value = `${e.value >= 0 ? '+' : '−'}${formatNumber(Math.abs(e.value), { decimals: 2 })}${e.percent ? '%' : ''}`;
			const family = e.family ? game.t('only {family}', { family: game.t(families.get(e.family) ?? e.family) }) : '';
			return `${game.t(`effect:${e.target}`)} ${value}${family}`;
		},
		/** "Barracks levels 6–20" over all of the tech's levels. */
		unlock(t: TechInfo, u: TechInfo['unlocks'][number]) {
			return game.t('{building} levels {from}–{to}', {
				building: game.t(buildings.get(u.building) ?? u.building),
				from: u.from,
				to: u.from + u.perLevel * t.maxLevel - 1,
			});
		},
	};
}
