// Small text helpers shared by the report components.
import type { Game } from '../../core/game';
import { formatNumber } from '../../core/format';

export function reportText(game: Game) {
	const unitNames = new Map((game.meta.units ?? []).map((u) => [u.id, u.name]));
	const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
	const settlementName = (id: string | null) => {
		const s = id ? game.view('settlements.mine')?.find((x) => x.id === id) : undefined;
		return s ? game.t(s.name) : '?';
	};
	return {
		settlementName,
		units: (u: Record<string, number>) =>
			Object.entries(u)
				.filter(([, n]) => n > 0)
				.map(([id, n]) => `${game.t(unitNames.get(id) ?? id)} ×${formatNumber(n)}`)
				.join('，'),
		amounts: (c: Record<string, number>) =>
			Object.entries(c)
				.filter(([, n]) => n > 0)
				.map(([r, n]) => `${icons.get(r) ?? r}${formatNumber(n)}`)
				.join(' '),
		promoted: (list: { from: string; to: string; count: number }[]) =>
			list
				.map((p) => `${game.t(unitNames.get(p.from) ?? p.from)} → ${game.t(unitNames.get(p.to) ?? p.to)} ×${formatNumber(p.count)}`)
				.join('，'),
	};
}
