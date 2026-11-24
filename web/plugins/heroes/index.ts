// Heroes in the browser: the Heroes page's cards, candidates and defence order, worked out from the heroes' data
// (the server sends data only; the widgets and their places are declared by the server plugin). What the heroes'
// commands did is told to the heroes held here at once (./patch.ts), and to the client plugins that show heroes in
// their own data (the `heroes` client service: realms, equipment...).
import type { HeroesState, HeroOffers } from '../../../src/shared/api';
import type { HeroGrowth } from '../../../src/shared/heroes';
import { defineClientPlugin, type Game } from '../../core/game';
import { formParts } from './forms';
import {
	allocate,
	allocated,
	changeInList,
	changeCard,
	changeInState,
	type HeroChange,
	type ListHero,
	moveHome,
	orderOf,
	recruit,
	recruited,
	removeFromList,
	removeFromState,
} from './patch';
import { views } from './views';

/** Who else shows the player's heroes in their own data, told what changed (they know their own views). */
export interface HeroListener {
	/** A hero changed (`hero`: as it is now, when held here). */
	changed?(id: string, change: HeroChange, hero: ListHero | undefined): void;
	removed?(id: string): void;
	/** A hero joined (recruited), as the list now has it. */
	added?(hero: ListHero): void;
	/** Heroes changed in a way only the server knows (one recruited, a rebirth): their own copies are old now. */
	unknown?(): void;
}

export interface HeroesClientService {
	/** A command changed a hero this way (e.g. an adventure set out: its duty): every view holding it follows. */
	update(id: string, change: HeroChange): void;
	remove(id: string): void;
	/** A hero joined (recruited): into the list, and the listeners' own copies. */
	add(hero: ListHero): void;
	/** Heroes changed in a way only the server knows: fetched again where they show next. */
	unknown(): void;
	/** The hero as held here (the latest `heroes.list`). */
	get(id: string): ListHero | undefined;
	listen(listener: HeroListener): void;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		heroes: HeroesClientService;
	}
}

function heroesService(game: Game): HeroesClientService {
	const listeners: HeroListener[] = [];
	const latest = () =>
		game
			.held<ListHero[]>('heroes.list')
			.filter((x) => Array.isArray(x.value))
			.sort((a, b) => b.at - a.at)[0]?.value;
	const tell = (fn: (l: HeroListener) => void) => {
		for (const l of listeners)
			try {
				fn(l);
			} catch (err) {
				console.error(err);
			}
	};
	const service: HeroesClientService = {
		get: (id) => latest()?.find((h) => h.id === id),
		update(id, change) {
			const before = service.get(id);
			// The old card, for a hero moving to a settlement whose state does not have it yet.
			const old = game
				.held<HeroesState | null>('heroes.state')
				.map((x) => x.value?.heroes.find((c) => c.id === id))
				.find((c) => !!c);
			game.patchView<ListHero[]>('heroes.list', (list) => changeInList(list, id, change));
			const hero = service.get(id) ?? (before ? { ...before, ...change } : undefined);
			if (hero) {
				const order = latest()?.map((h) => h.id) ?? [];
				game.patchView<HeroesState>('heroes.state', (state) => changeInState(state, hero, order, old));
			} else if (change.home) game.markStale('heroes.state');
			else game.patchView<HeroesState>('heroes.state', (state) => changeCard(state, id, change));
			tell((l) => l.changed?.(id, change, hero));
		},
		add(hero) {
			game.patchView<ListHero[]>('heroes.list', (list) => (list.some((h) => h.id === hero.id) ? list : [...list, hero]));
			tell((l) => l.added?.(hero));
		},
		remove(id) {
			game.patchView<ListHero[]>('heroes.list', (list) => removeFromList(list, id));
			game.patchView<HeroesState>('heroes.state', (state) => removeFromState(state, id));
			tell((l) => l.removed?.(id));
		},
		unknown() {
			game.markStale('heroes.list');
			game.markStale('heroes.state');
			tell((l) => l.unknown?.());
		},
		listen: (l) => void listeners.push(l),
	};
	return service;
}

export default defineClientPlugin({
	id: 'heroes',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		const heroes = heroesService(game);
		game.provide('heroes', heroes);

		// The heroes' own commands (the server checks each; these run once it said yes).
		const payloadOf = (p: unknown) => (p ?? {}) as Record<string, unknown>;
		game.afterCommand('heroes.assign', (_t, payload) => {
			const { hero, duty, target } = payloadOf(payload) as { hero: string; duty: string; target?: string | null };
			heroes.update(hero, { duty, dutyTarget: duty === 'idle' ? null : (target ?? null) });
		});
		game.afterCommand('heroes.allocate', (_t, payload) => {
			const p = payloadOf(payload);
			const hero = heroes.get(p.hero as string);
			if (hero) heroes.update(hero.id, allocate(hero, allocated(p)));
			else heroes.unknown();
		});
		game.afterCommand('heroes.dismiss', (_t, payload) => heroes.remove(payloadOf(payload).hero as string));
		game.afterCommand('heroes.setHome', (_t, payload) => {
			const { hero: id, settlement } = payloadOf(payload) as { hero: string; settlement: string };
			const hero = heroes.get(id);
			const anywhere = new Map((game.meta.heroes?.duties ?? []).map((d) => [d.id, d.anywhere]));
			heroes.update(id, hero ? moveHome(hero, settlement, (d) => !!anywhere.get(d)) : { home: settlement });
		});
		game.afterCommand('heroes.setDefenseOrder', (_t, payload) => {
			const { settlement, heroes: ids = [] } = payloadOf(payload) as { settlement: string; heroes?: string[] };
			const order = orderOf(ids);
			game.patchView<{ settlement: string; order: string[] | null } | null>('heroes.defense', (d) =>
				d && d.settlement === settlement ? { ...d, order } : d,
			);
			game.patchView<HeroesState>('heroes.state', (s) => (s.settlement.id === settlement ? { ...s, order } : s));
		});
		// Recruited: the new hero is the candidate (held in `heroes.offers`) with the id the answer says ("heroes.recruited"),
		// at level 1 by the growth rule (static `heroes.growth`); then the candidate is gone from where it stood.
		game.afterCommand('heroes.recruit', (_t, payload, reply) => {
			const p = payloadOf(payload) as { settlement: string; venue: string; slot?: number; gift?: string };
			const offers = game
				.held<HeroOffers | null>('heroes.offers')
				.map((x) => x.value)
				.find((o) => o?.settlement === p.settlement);
			const id = reply['heroes.recruited'];
			const growth = game.static<HeroGrowth>('heroes.growth');
			const hero = offers && typeof id === 'string' && growth ? recruit(offers, p, id, growth) : null;
			if (hero) heroes.add(hero);
			else heroes.unknown();
			game.patchView<HeroOffers>('heroes.offers', (o) => recruited(o, { ...p, slot: p.slot === undefined ? undefined : Number(p.slot) }));
		});
		// Heroes any command made (recruited; given by a puzzle, a mail, an item): the answer says them (`reply`
		// "heroes.created", user 2026-11-24: "干干净净一个新英雄ID"; "有些英雄还可以通过拼图系统兑换"), into the big object.
		game.afterCommand(
			() => true,
			(_t, _p, reply) => {
				const given = (reply['heroes.created'] ?? []) as ListHero[];
				for (const hero of given) heroes.add(hero);
				// One more of the player's heroes, and maybe a limit raised by them ("赠送英雄"): worked out on the server.
				if (given.length) game.markStale('heroes.state');
			},
		);
	},
});
