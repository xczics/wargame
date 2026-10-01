/**
 * Heroes (docs/design/gameplay.md §5): named characters with attributes, recruited at
 * venues (buildings), attached to a settlement ("home"), each on one duty at a time.
 *
 * The system knows none of the content: attributes, venues (and how they roll candidates)
 * and duties are registered by content plugins, and so are the effects — a content plugin
 * reads who is on which duty (`onDuty`) and feeds its bonuses into the systems that own them
 * (battle modifiers, production, research...). `onDutyChange` lets it settle what changes.
 *
 * Candidates: each venue offers a few per settlement, renewed every refresh window. They are
 * derived from (settlement, venue, window, slot) with seeded randomness, so nothing is stored
 * until one is recruited (`heroes_taken` keeps the recruited slots).
 */
import { csvRules, definePlugin, GameError, numberInRange, PluginError, seededRandom, type EngineApi, type ReadApi } from '../../kernel';
import type { HeroCandidates, HeroInfo } from '../../shared/api';
import type { Cost } from '../resources';
import rulesCsv from './data/rules.csv?raw';

const RULES = csvRules(rulesCsv);

export interface AttributeDef {
	id: string;
	name: string;
}

/** A rolled candidate. */
export interface HeroDraft {
	surname: string;
	given: string;
	gender: 'm' | 'f';
	attrs: Record<string, number>;
}

export interface VenueDef {
	id: string;
	name: string;
	/** The building that hosts it: a settlement needs one to recruit here. */
	building: string;
	/** Candidates per window and the window length (seconds), by building level. */
	offer(api: ReadApi, level: number): { count: number; seconds: number };
	/** Roll one candidate with the given random numbers, or null (none in this slot this time). */
	draft(api: ReadApi, random: () => number, slot: number): HeroDraft | null;
	cost(api: ReadApi): Cost;
}

export interface DutyDef {
	id: string;
	name: string;
	/** Heroes on this duty are at home (e.g. can defend it). */
	inTown: boolean;
	/** Players choose it with `heroes.assign` (false: only other plugins assign it, e.g. leading an army). */
	manual: boolean;
	/**
	 * The target may be other than the hero's home settlement (e.g. an army it leads). By default
	 * a hero serves only in the settlement it is attached to.
	 */
	anywhere?: boolean;
	/** Why `hero` cannot take this duty for `target` (a settlement id for manual duties), or null. Must only read. */
	check?(api: EngineApi, hero: Hero, target: string | null): Promise<string | null>;
}

export interface Hero {
	id: string;
	playerId: string;
	surname: string;
	given: string;
	gender: 'm' | 'f';
	origin: string;
	attrs: Record<string, number>;
	home: string;
	duty: string;
	dutyTarget: string | null;
	createdAt: number;
}

/** Called just before a hero changes duty (`hero` is still as it was), e.g. to settle production. */
export type DutyChange = (api: EngineApi, hero: Hero, next: { duty: string; target: string | null }) => Promise<void>;

export interface HeroesService {
	defineAttribute(def: AttributeDef): void;
	attributes(): readonly AttributeDef[];
	defineVenue(def: VenueDef): void;
	defineDuty(def: DutyDef): void;
	duty(id: string): DutyDef;
	/** A player's heroes. */
	list(api: ReadApi, playerId: string): Promise<Hero[]>;
	get(api: ReadApi, id: string): Promise<Hero | null>;
	/** Heroes on `duty` for `target` (any player). */
	onDuty(api: ReadApi, duty: string, target: string): Promise<Hero[]>;
	/** Put a hero on a duty (checks the duty's rules); "idle" frees it. Notifies `onDutyChange` first. */
	assign(api: EngineApi, heroId: string, duty: string, target: string | null): Promise<void>;
	onDutyChange(listener: DutyChange): void;
	/** Attach a hero to another settlement of its player (e.g. it moved there with an army). */
	setHome(api: EngineApi, heroId: string, settlementId: string): Promise<void>;
	/**
	 * The first `n` heroes defending a settlement: its defence order (else all heroes attached
	 * to it, best `defenseScore` first), skipping those not in town (their duty is away).
	 */
	defenders(api: ReadApi, settlementId: string, n: number): Promise<Hero[]>;
	/** How good a hero is at defending, for the default order (content decides, e.g. might + leadership). */
	setDefenseScore(score: (hero: Hero) => number): void;
}

declare module '../../kernel' {
	interface ServiceMap {
		heroes: HeroesService;
	}
}

interface Row {
	id: string;
	player_id: string;
	surname: string;
	given: string;
	gender: 'm' | 'f';
	origin: string;
	attrs: string;
	home: string;
	duty: string;
	duty_target: string | null;
	created_at: number;
}
const toHero = (r: Row): Hero => ({
	id: r.id,
	playerId: r.player_id,
	surname: r.surname,
	given: r.given,
	gender: r.gender,
	origin: r.origin,
	attrs: JSON.parse(r.attrs),
	home: r.home,
	duty: r.duty,
	dutyTarget: r.duty_target,
	createdAt: r.created_at,
});

export default definePlugin({
	id: 'heroes',
	version: '0.1.0',
	description: 'Heroes: recruitment at venues, attributes, duties',
	dependsOn: ['settlements', 'buildings', 'resources', 'stats'],
	setup(ctx) {
		const settlements = ctx.services.get('settlements');
		const buildings = ctx.services.get('buildings');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const attributes = new Map<string, AttributeDef>();
		const venues = new Map<string, VenueDef>();
		const duties = new Map<string, DutyDef>();
		const listeners: DutyChange[] = [];
		let defenseScore = (_h: Hero) => 0;
		const loadOrder = (api: ReadApi, settlementId: string) =>
			api.memo(`heroes:order:${settlementId}`, async () => {
				const row = await api.db
					.prepare('SELECT heroes FROM heroes_defense WHERE settlement_id = ?')
					.bind(settlementId)
					.first<{ heroes: string }>();
				return { heroes: row ? (JSON.parse(row.heroes) as string[]) : null };
			});

		const cap = ctx.config.define('cap', {
			description: 'Heroes a player may have before bonuses (buildings, research... add to stat heroes.cap).',
			default: () => RULES.cap as number,
			parse: numberInRange(0, 10_000),
		});
		stats.define({ id: 'heroes.cap', description: 'hero limit', base: (api) => cap.get(api), integer: true, min: 0 });

		/** Heroes of a player, loaded once per call; changes in a command are reflected. */
		const loadMine = (api: ReadApi, playerId: string) =>
			api.memo(`heroes:mine:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT * FROM heroes_heroes WHERE player_id = ? ORDER BY created_at')
					.bind(playerId)
					.all<Row>();
				return results.map(toHero);
			});
		const write = (api: EngineApi, h: Hero) =>
			api.write(
				api.db
					.prepare(
						`INSERT INTO heroes_heroes (id, player_id, surname, given, gender, origin, attrs, home, duty, duty_target, created_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (id) DO UPDATE SET home = excluded.home, duty = excluded.duty, duty_target = excluded.duty_target, attrs = excluded.attrs`,
					)
					.bind(
						h.id,
						h.playerId,
						h.surname,
						h.given,
						h.gender,
						h.origin,
						JSON.stringify(h.attrs),
						h.home,
						h.duty,
						h.dutyTarget,
						h.createdAt,
					),
			);

		duties.set('idle', { id: 'idle', name: 'Idle', inTown: true, manual: true });

		const service: HeroesService = {
			defineAttribute(def) {
				if (attributes.has(def.id)) throw new PluginError(`Hero attribute "${def.id}" defined twice`);
				attributes.set(def.id, def);
			},
			attributes: () => [...attributes.values()],
			defineVenue(def) {
				if (venues.has(def.id)) throw new PluginError(`Hero venue "${def.id}" defined twice`);
				venues.set(def.id, def);
			},
			defineDuty(def) {
				if (duties.has(def.id)) throw new PluginError(`Hero duty "${def.id}" defined twice`);
				duties.set(def.id, def);
			},
			duty(id) {
				const d = duties.get(id);
				if (!d) throw new GameError('bad_payload', `Unknown duty "${id}"`);
				return d;
			},
			list: (api, playerId) => loadMine(api, playerId),
			async get(api, id) {
				const row = await api.db.prepare('SELECT player_id FROM heroes_heroes WHERE id = ?').bind(id).first<{ player_id: string }>();
				return row ? ((await loadMine(api, row.player_id)).find((h) => h.id === id) ?? null) : null;
			},
			async onDuty(api, duty, target) {
				const owners = await api.memo(`heroes:owners:${duty}:${target}`, async () => {
					const { results } = await api.db
						.prepare('SELECT player_id FROM heroes_heroes WHERE duty = ? AND duty_target = ? GROUP BY player_id')
						.bind(duty, target)
						.all<{ player_id: string }>();
					return results.map((r) => r.player_id);
				});
				// Through the per-player lists (the acting player's always), so changes made earlier in this command count.
				const out: Hero[] = [];
				for (const player of new Set([...owners, api.playerId]))
					out.push(...(await loadMine(api, player)).filter((h) => h.duty === duty && h.dutyTarget === target));
				return out;
			},
			async assign(api, heroId, dutyId, target) {
				const hero = await service.get(api, heroId);
				if (!hero) throw new GameError('not_found', 'No such hero', 404);
				const duty = service.duty(dutyId);
				if (dutyId !== 'idle' && !duty.anywhere && target !== hero.home)
					throw new GameError('blocked', 'A hero serves only in the settlement it is attached to');
				const reason = dutyId === 'idle' ? null : await duty.check?.(api, hero, target);
				if (reason) throw new GameError('blocked', reason);
				const next = { duty: dutyId, target: dutyId === 'idle' ? null : target };
				for (const l of listeners) await l(api, hero, next);
				hero.duty = next.duty;
				hero.dutyTarget = next.target;
				write(api, hero);
			},
			onDutyChange: (l) => void listeners.push(l),
			async setHome(api, heroId, settlementId) {
				const hero = await service.get(api, heroId);
				const s = await settlements.get(api, settlementId);
				if (!hero || !s || s.ownerId !== hero.playerId) throw new GameError('not_found', 'No such hero or settlement', 404);
				// A post tied to the old home ends (its bonuses stop, banked first by the duty listeners).
				if (hero.duty !== 'idle' && !service.duty(hero.duty).anywhere && hero.dutyTarget !== settlementId)
					await service.assign(api, heroId, 'idle', null);
				hero.home = settlementId;
				write(api, hero);
			},
			async defenders(api, settlementId, n) {
				const s = await settlements.get(api, settlementId);
				if (!s?.ownerId || n <= 0) return [];
				const attached = (await loadMine(api, s.ownerId)).filter((h) => h.home === settlementId);
				const { heroes: order } = await loadOrder(api, settlementId);
				const ranked = order
					? order.map((id) => attached.find((h) => h.id === id)).filter((h): h is Hero => !!h)
					: [...attached].sort((a, b) => defenseScore(b) - defenseScore(a));
				return ranked.filter((h) => duties.get(h.duty)?.inTown !== false).slice(0, n);
			},
			setDefenseScore: (score) => void (defenseScore = score),
		};
		ctx.services.provide('heroes', service);

		/* ----- recruitment ---------------------------------------------------------------- */

		/** A venue's current offer in a settlement: window, time left and candidates (null = taken or none). */
		async function offer(api: EngineApi, settlementId: string, venue: VenueDef) {
			const level = await buildings.level(api, settlementId, venue.building);
			if (!level) return null;
			const { count, seconds } = venue.offer(api, level);
			const period = Math.max(60, seconds) * 1000;
			const window = Math.floor(api.now / period);
			const { results } = await api.db
				.prepare('SELECT slot FROM heroes_taken WHERE settlement_id = ? AND venue = ? AND win = ?')
				.bind(settlementId, venue.id, window)
				.all<{ slot: number }>();
			const taken = new Set(results.map((r) => r.slot));
			const candidates = Array.from({ length: count }, (_, slot) =>
				taken.has(slot) ? null : venue.draft(api, seededRandom(`hero:${settlementId}:${venue.id}:${window}:${slot}`), slot),
			);
			return { level, window, refreshesAt: (window + 1) * period, candidates, taken: [...taken] };
		}

		ctx.views.add({
			id: 'heroes.candidates',
			async compute(api, params): Promise<HeroCandidates[]> {
				const s = await settlements.resolve(api, params);
				if (!s) return [];
				const out: HeroCandidates[] = [];
				for (const v of venues.values()) {
					const o = await offer(api, s.id, v);
					if (!o) continue;
					out.push({
						venue: v.id,
						name: v.name,
						settlement: s.id,
						refreshesAt: o.refreshesAt,
						cost: v.cost(api),
						taken: o.taken,
						candidates: o.candidates.map((c, slot) => (c ? { slot, ...c } : null)),
					});
				}
				return out;
			},
		});

		ctx.commands.add<{ settlement: string; venue: string; slot: number }>({
			type: 'heroes.recruit',
			description: 'Recruit a candidate. Payload: { "settlement", "venue", "slot" }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string' || typeof p.venue !== 'string')
					throw new GameError('bad_payload', 'settlement and venue are required');
				const slot = Number(p.slot);
				if (!Number.isInteger(slot) || slot < 0) throw new GameError('bad_payload', 'slot must be a whole number');
				return { settlement: p.settlement, venue: p.venue, slot };
			},
			async execute(api, { settlement, venue: venueId, slot }) {
				const s = await settlements.requireOwned(api, settlement);
				const venue = venues.get(venueId);
				if (!venue) throw new GameError('bad_payload', 'Unknown venue');
				const o = await offer(api, s.id, venue);
				if (!o) throw new GameError('blocked', `Requires ${buildings.get(venue.building).name}`);
				const draft = o.candidates[slot];
				if (!draft) throw new GameError('gone', 'That candidate is no longer available');
				const mine = await loadMine(api, api.playerId);
				if (mine.length >= (await stats.get(api, 'heroes.cap', `player:${api.playerId}`)))
					throw new GameError('blocked', 'Hero limit reached');
				await resources.spend(api, settlements.entity(s.id), venue.cost(api));
				const hero: Hero = {
					id: crypto.randomUUID(),
					playerId: api.playerId,
					...draft,
					origin: venue.id,
					home: s.id,
					duty: 'idle',
					dutyTarget: null,
					createdAt: api.now,
				};
				mine.push(hero);
				write(api, hero);
				// The primary key keeps a candidate from being recruited twice, even by commands racing.
				api.write(
					api.db
						.prepare('INSERT INTO heroes_taken (settlement_id, venue, win, slot) VALUES (?, ?, ?, ?)')
						.bind(s.id, venue.id, o.window, slot),
				);
			},
		});

		/* ----- managing heroes ------------------------------------------------------------ */

		const owned = async (api: EngineApi, heroId: string) => {
			const hero = (await loadMine(api, api.playerId)).find((h) => h.id === heroId);
			if (!hero) throw new GameError('not_found', 'No such hero', 404);
			return hero;
		};

		ctx.commands.add<{ hero: string; duty: string; target: string | null }>({
			type: 'heroes.assign',
			description: 'Put a hero on a duty ("idle" to free it). Payload: { "hero", "duty", "target": "<settlement>" }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.hero !== 'string' || typeof p.duty !== 'string') throw new GameError('bad_payload', 'hero and duty are required');
				return { hero: p.hero, duty: p.duty, target: typeof p.target === 'string' && p.target ? p.target : null };
			},
			async execute(api, { hero: heroId, duty, target }) {
				const hero = await owned(api, heroId);
				if (!service.duty(duty).manual) throw new GameError('blocked', 'That duty is not chosen this way');
				if (!service.duty(hero.duty).manual) throw new GameError('blocked', 'The hero is busy');
				if (target) await settlements.requireOwned(api, target);
				await service.assign(api, hero.id, duty, target);
			},
		});

		ctx.commands.add<{ hero: string; settlement: string }>({
			type: 'heroes.setHome',
			description: 'Attach a hero to another of your settlements. Payload: { "hero", "settlement" }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.hero !== 'string' || typeof p.settlement !== 'string')
					throw new GameError('bad_payload', 'hero and settlement are required');
				return { hero: p.hero, settlement: p.settlement };
			},
			async execute(api, { hero: heroId, settlement }) {
				await owned(api, heroId);
				await settlements.requireOwned(api, settlement);
				await service.setHome(api, heroId, settlement);
			},
		});

		ctx.commands.add<{ hero: string }>({
			type: 'heroes.dismiss',
			description: 'Let an idle hero go. Payload: { "hero" }',
			parse(raw) {
				const hero = (raw as { hero?: unknown } | null)?.hero;
				if (typeof hero !== 'string') throw new GameError('bad_payload', 'hero is required');
				return { hero };
			},
			async execute(api, { hero: heroId }) {
				const hero = await owned(api, heroId);
				if (hero.duty !== 'idle') throw new GameError('blocked', 'Only idle heroes can be dismissed');
				const mine = await loadMine(api, api.playerId);
				mine.splice(mine.indexOf(hero), 1);
				api.write(api.db.prepare('DELETE FROM heroes_heroes WHERE id = ?').bind(hero.id));
			},
		});

		ctx.commands.add<{ settlement: string; heroes: string[] }>({
			type: 'heroes.setDefenseOrder',
			description:
				'Order the heroes defending a settlement (from those attached to it; more than the limit = substitutes). Payload: { "settlement", "heroes": ["<id>", ...] }; [] = back to strongest first.',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string' || !Array.isArray(p.heroes) || !p.heroes.every((h) => typeof h === 'string'))
					throw new GameError('bad_payload', 'settlement and heroes (a list of ids) are required');
				return { settlement: p.settlement, heroes: [...new Set(p.heroes as string[])] };
			},
			async execute(api, { settlement, heroes: ids }) {
				await settlements.requireOwned(api, settlement);
				const mine = await loadMine(api, api.playerId);
				for (const id of ids)
					if (mine.find((h) => h.id === id)?.home !== settlement)
						throw new GameError('bad_payload', 'Only heroes attached to this settlement can defend it');
				(await loadOrder(api, settlement)).heroes = ids.length ? ids : null;
				api.write(
					ids.length
						? api.db
								.prepare(
									'INSERT INTO heroes_defense (settlement_id, heroes) VALUES (?, ?) ON CONFLICT (settlement_id) DO UPDATE SET heroes = excluded.heroes',
								)
								.bind(settlement, JSON.stringify(ids))
						: api.db.prepare('DELETE FROM heroes_defense WHERE settlement_id = ?').bind(settlement),
				);
			},
		});

		ctx.views.add({
			id: 'heroes.defense',
			async compute(api, params): Promise<{ settlement: string; order: string[] | null } | null> {
				const s = await settlements.resolve(api, params);
				return s ? { settlement: s.id, order: (await loadOrder(api, s.id)).heroes } : null;
			},
		});

		ctx.views.add({
			id: 'heroes.list',
			async compute(api): Promise<HeroInfo[]> {
				return (await loadMine(api, api.playerId)).map(({ playerId: _, createdAt: __, ...h }) => h);
			},
		});

		ctx.meta.add('heroes', () => ({
			attributes: service.attributes(),
			duties: [...duties.values()].map(({ id, name, inTown, manual, anywhere }) => ({ id, name, inTown, manual, anywhere: !!anywhere })),
			venues: [...venues.values()].map(({ id, name, building }) => ({ id, name, building })),
		}));
	},
});
