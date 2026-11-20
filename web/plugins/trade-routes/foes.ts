// What the enemy's men are called on a trade route (user 2026-11-20: "给商路开拓敌军的兵种额外取名……等级和数值不变，就改个
// 名字"): the chapter's name for the unit's family with a word for its tier ("老练沙匪刀手"), else the unit's own name.
import type { Game } from '../../core/game';

export function foeName(game: Game, route: string, chapter: number, unit: string) {
	const u = game.meta.units?.find((x) => x.id === unit);
	const name = u?.family ? game.use('tradeRoutes').foe(route, chapter, u.family) : undefined;
	if (!name || !u?.tier) return u ? game.t(u.name) : unit;
	return game.t('{tier}{name}', { tier: game.t(`foe-tier:${u.tier}`), name: game.t(name) });
}
