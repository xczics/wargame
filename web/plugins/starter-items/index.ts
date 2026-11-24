// The starter-items plugin in the browser: words its items' forms from the data their `prepare` sends (./forms.ts), and
// changes the player's data held here the way a use of one of its items did (./patches.ts; user 2026-11-20: "你告诉前端成功
// 了，前端不就能更新了吗？"), so every page shows it at once. The one used comes off the inventory with the items plugin.
// What only the server can tell (a roll, a level reached, what a completion brings) is made old: asked for again with
// the sync of the page that shows it next. Its items' forms elsewhere that show what a use changed (odds, a boost's end,
// a truce) are made old too.
import type {
	BanditsState,
	BuildingsState,
	GarrisonInfo,
	HeroesState,
	RealmsOverview,
	ResearchState,
	SettlementOutline,
	StarterItemUses,
	TroopsState,
	UnitCatalog,
} from '../../../src/shared/api';
import { expToNextOf, type HeroGrowth, withExp } from '../../../src/shared/heroes';
import { movedUnits } from '../../../src/shared/troops';
import { defineClientPlugin, type Game } from '../../core/game';
import { formParts } from './forms';
import {
	buildingRazed,
	buildingsMoved,
	constructionSooner,
	garrisonSooner,
	healed,
	renamedTo,
	repeatsAfter,
	researchSooner,
	respecced,
	settlementRenamed,
	stateSooner,
	truce,
} from './patches';

const PREFIX = 'items.use.';
/** The latest the browser holds of a view, whatever it was asked with. */
const latest = <T>(game: Game, view: string) => game.held<T>(view).sort((a, b) => b.at - a.at)[0]?.value;
const stale = (game: Game, ...views: string[]) => views.forEach((v) => game.markStale(v));

/** A settlement's slot as a form sends it ("district:slot", or both apart). */
function slotOf(p: { target?: string; district?: string; slot?: unknown }) {
	if (p.target) {
		const at = p.target.lastIndexOf(':');
		return { district: p.target.slice(0, at), slot: Number(p.target.slice(at + 1)) };
	}
	return p.district !== undefined && p.slot !== undefined ? { district: p.district, slot: Number(p.slot) } : null;
}

/** Units come into a settlement's garrison, wherever it is held (upkeep from none: the server's to tell). */
function unitsJoined(game: Game, settlement: string, units: Record<string, number>) {
	const catalog = game.static<UnitCatalog>('troops.units');
	const moved = Object.fromEntries(Object.entries(units).map(([u, n]) => [u, -n]));
	let empty = false;
	const join = <G extends { units: { id: string; count: number }[]; upkeep: Record<string, number> }>(g: G) => {
		empty ||= !g.units.length;
		return movedUnits(g, moved, (u) => catalog?.[u]);
	};
	game.patchView<TroopsState>('troops.state', (s) => ({
		...s,
		garrisons: s.garrisons.map((g) => (g.settlement === settlement ? join(g) : g)),
	}));
	game.patchView<GarrisonInfo | null>('troops.garrison', (g) => (g && g.settlement === settlement ? join(g) : g));
	if (empty) stale(game, 'troops.state', 'troops.garrison');
}

function used(game: Game, item: string, payload: Record<string, unknown>, now: number) {
	const use = game.static<StarterItemUses>('starter-items.uses')?.[item];
	const settlement = typeof payload.settlement === 'string' ? payload.settlement : '';
	const hero = typeof payload.hero === 'string' ? payload.hero : '';
	switch (item) {
		// May raise (a roll): the outer cities' limit, a building's cap, an outer city's slots, how many may be founded.
		case 'expansion-permit':
		case 'land-grant':
			return stale(game, 'buildings.state', 'settlements.outline');
		case 'breakthrough-stone':
			return stale(game, 'buildings.state');
		// How many may be founded (a roll): only the founding form shows it (held forms are old after every command).
		case 'city-charter':
		case 'resource-fortress-charter':
		case 'military-fortress-charter':
			return;
		case 'razing-order': {
			const at = slotOf(payload);
			if (at) game.patchView<BuildingsState | null>('buildings.state', (s) => buildingRazed(s, settlement, at.district, at.slot));
			// What it gave (production, queue room, a post) goes with it: the server's numbers.
			return stale(game, 'buildings.state', 'resources.sources', 'starter-heroes.posts');
		}
		case 'relocation-order':
		case 'exchange-order': {
			const { district, from, to } = payload as { district: string; from: unknown; to: unknown };
			game.patchView<BuildingsState | null>('buildings.state', (s) =>
				buildingsMoved(s, settlement, district, Number(from), Number(to), item === 'exchange-order'),
			);
			return;
		}
		case 'name-card': {
			// Through the heroes' service: every view naming heroes follows (the realms, the gear, the posts).
			game.use('heroes').update(hero, renamedTo(String(payload.name ?? '')));
			return;
		}
		case 'renaming-decree': {
			const name = String(payload.name ?? '');
			game.patchView<SettlementOutline | null>('settlements.outline', (o) => settlementRenamed.outline(o, settlement, name));
			game.patchView<BuildingsState | null>('buildings.state', (s) => settlementRenamed.buildings(s, settlement, name));
			game.patchView<HeroesState | null>('heroes.state', (s) => settlementRenamed.heroes(s, settlement, name));
			game.patchView<TroopsState>('troops.state', (s) => settlementRenamed.troops(s, settlement, name));
			game.patchView<ResearchState>('research.state', (r) => settlementRenamed.research(r, settlement, name));
			return;
		}
		// A candidate drawn (or not), the candidates drawn again.
		case 'music-house-invitation':
			return stale(game, 'heroes.offers');
		case 'tavern-banner':
		case 'academy-notice':
			return stale(game, 'heroes.offers');
	}
	if (!use) return;
	switch (use.effect) {
		case 'veterans': {
			const building = String(payload.building ?? '');
			const units: Record<string, number> = {};
			for (const u of game.meta.units ?? [])
				if (u.trainedAt === building && u.family && u.tier !== undefined && use.units?.[String(u.tier)])
					units[u.id] = use.units[String(u.tier)];
			return unitsJoined(game, settlement, units);
		}
		case 'speedup': {
			if (use.target === 'construction') {
				const at = slotOf(payload);
				if (!at) return;
				let done = false;
				game.patchView<BuildingsState | null>('buildings.state', (s) => {
					const r = constructionSooner(s, settlement, at, use.amount, now);
					if (r.finishesAt !== undefined) done ||= r.finishesAt <= now;
					return r.state;
				});
				// Done now: what it built is the server's to tell (levels, production, the queue).
				if (done) stale(game, 'buildings.state', 'resources.sources', 'settlements.outline');
				return;
			}
			if (use.target === 'training') {
				const line = String(payload.barracks ?? '');
				const lineOf = new Map((game.meta.units ?? []).map((u) => [u.id, u.trainedAt]));
				let done = false;
				game.patchView<GarrisonInfo | null>('troops.garrison', (g) => {
					const r = garrisonSooner(g, settlement, line, use.amount, now);
					if (r.finishesAt !== undefined) done ||= r.finishesAt <= now;
					return r.garrison;
				});
				game.patchView<TroopsState>('troops.state', (s) => stateSooner(s, settlement, line, (u) => lineOf.get(u), use.amount, now));
				// Done now: the units are in, the next batch started (the server's queue).
				if (done) stale(game, 'troops.state', 'troops.garrison');
				return;
			}
			if (use.target === 'research') {
				let done = false;
				game.patchView<ResearchState>('research.state', (r) => {
					const x = researchSooner(r, settlement, use.amount, now);
					if (x.finishesAt !== undefined) done ||= x.finishesAt <= now;
					return x.state;
				});
				if (done) stale(game, 'research.state');
			}
			return;
		}
		// Production up (the server's sums of every source).
		case 'boost':
			return stale(game, 'resources.sources');
		case 'heal':
			game.patchView<RealmsOverview>('realms.overview', (o) => healed(o, hero));
			game.use('heroes').update(hero, { duty: 'idle', dutyTarget: null });
			return;
		case 'exp': {
			// Levels reached and what they bring by the growth rule (static `heroes.growth`) and the same function as the
			// server (user 2026-11-24: "英雄经验要求难道不是通用规则吗？不早该缓存到那静态资源里了吗").
			const h = game.use('heroes').get(hero);
			const growth = game.static<HeroGrowth>('heroes.growth');
			if (!h || !growth) return game.use('heroes').unknown();
			const after = withExp(h, use.amount, growth);
			game.use('heroes').update(hero, {
				level: after.level,
				exp: after.exp,
				expToNext: expToNextOf(growth, after.level),
				freePoints: after.freePoints,
				attrs: after.attrs,
			});
			return;
		}
		case 'respec': {
			const h = game.use('heroes').get(hero);
			if (h) game.use('heroes').update(hero, respecced(h));
			else game.use('heroes').unknown();
			return;
		}
		// May raise a player stat (a roll): the hero limit on the Heroes page.
		case 'stat':
			return stale(game, 'heroes.state');
		case 'truce':
			game.patchView<BanditsState>('bandits.state', (b) => ({ protectedUntil: truce(b.protectedUntil, use.amount, now) }));
			return;
	}
}

export default defineClientPlugin({
	id: 'starter-items',
	// Its hero items change heroes through the heroes' client service.
	dependsOn: ['heroes'],
	setup(game) {
		for (const p of formParts) game.clientPart(p);
		game.afterCommand(
			(type) => type.startsWith(PREFIX),
			(type, payload, _reply, now) => used(game, type.slice(PREFIX.length), (payload ?? {}) as Record<string, unknown>, now),
		);
		// Travel packs (the realms' repeat supply) bought, claimed, used: how often an adventure may go round again, on the
		// Realms page, follows the packs held here (more of them: as the rule allows, the server's to tell).
		let packs: number | undefined;
		game.afterCommand(
			() => true,
			() => {
				const owned = latest<Record<string, number>>(game, 'items.owned');
				if (!owned) return;
				const now = owned['travel-pack'] ?? 0;
				const before = packs;
				packs = now;
				if (before === now) return;
				let unknown = false;
				game.patchView<RealmsOverview>('realms.overview', (o) => {
					// Not seen before (the first command here): fewer than it allows, known; more, the server's to tell.
					const r =
						before === undefined ? (now < o.repeats ? now : now > o.repeats ? undefined : o.repeats) : repeatsAfter(o.repeats, before, now);
					if (r === undefined) unknown = true;
					return r === undefined ? o : { ...o, repeats: r };
				});
				if (unknown) game.markStale('realms.overview');
			},
			{ answered: true },
		);
	},
});
