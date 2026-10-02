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
 *
 * Growth (§5.5): experience raises the level; each level adds the hero's talent points (fixed per
 * attribute at recruitment) — older heroes without them get their talent total spread at random —
 * points, spread by its natural attributes, and free points the player spends. Other plugins
 * add to the attributes (`addAttributeBonus`, e.g. equipment); `attributesOf` includes them.
 */
import {
	csvRules,
	definePlugin,
	GameError,
	numberFields,
	numberInRange,
	PluginError,
	seededRandom,
	type EngineApi,
	type ReadApi,
} from '../../kernel';
import type { HeroCandidates, HeroInfo } from '../../shared/api';
import type { Cost } from '../resources';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

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
	/** Attribute points gained at every level up, by attribute (fixed at recruitment). */
	talents?: Record<string, number>;
	/** Their total, for drafts without a split (default 3). */
	talent?: number;
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
	level: number;
	/** Experience towards the next level. */
	exp: number;
	talent: number;
	/** Talent points by attribute, added at every level up; null for heroes from before the split. */
	talents: Record<string, number> | null;
	freePoints: number;
	/** Free points spent, by attribute (already included in `attrs`). */
	alloc: Record<string, number>;
}

/** Extra attributes for a hero (e.g. its equipment). Must only read. */
export type AttributeBonus = (api: ReadApi, hero: Hero) => Promise<Record<string, number>>;
/** Called just before a hero's attributes change (level up, points spent...), e.g. to settle what they affect. */
export type AttributesChange = (api: EngineApi, hero: Hero) => Promise<void>;

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
	/** A hero's name as plain text (e.g. for form options); content decides how name parts are spelled. */
	nameOf(hero: { surname: string; given: string }): string;
	setNameFormatter(format: (hero: { surname: string; given: string }) => string): void;
	/** A random name (name-part keys, as heroes store them) for heroes that are not recruited, e.g. NPC defenders. */
	randomName(random: () => number, gender?: 'm' | 'f'): { surname: string; given: string };
	setNameGenerator(generate: (random: () => number, gender: 'm' | 'f') => { surname: string; given: string }): void;
	/** The hero's own attributes plus every bonus (what effects should use). */
	attributesOf(api: ReadApi, hero: Hero): Promise<Record<string, number>>;
	addAttributeBonus(bonus: AttributeBonus): void;
	onAttributesChange(listener: AttributesChange): void;
	/** Tell the listeners a hero's attributes are about to change (call before changing a bonus, e.g. equipment). */
	attributesChanging(api: EngineApi, heroId: string): Promise<void>;
	/** Experience needed from `level` to the next one, or null at the level cap. */
	expToNext(api: ReadApi, level: number): number | null;
	/** Give experience; levels up as far as it goes. Returns the levels gained. */
	grantExp(api: EngineApi, heroId: string, exp: number): Promise<number>;
	/** Take back every spent free point (they can be spent again). */
	resetFree(api: EngineApi, heroId: string): Promise<void>;
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
	level: number;
	exp: number;
	talent: number;
	talents: string | null;
	free_points: number;
	alloc: string;
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
	level: r.level ?? 1,
	exp: r.exp ?? 0,
	talent: r.talent ?? 3,
	talents: r.talents ? JSON.parse(r.talents) : null,
	freePoints: r.free_points ?? 0,
	alloc: JSON.parse(r.alloc ?? '{}'),
});

export default definePlugin({
	id: 'heroes',
	version: '0.1.0',
	description: 'Heroes: recruitment at venues, attributes, duties',
	dependsOn: ['settlements', 'buildings', 'resources', 'stats', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const settlements = ctx.services.get('settlements');
		const buildings = ctx.services.get('buildings');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const attributes = new Map<string, AttributeDef>();
		const venues = new Map<string, VenueDef>();
		const duties = new Map<string, DutyDef>();
		const listeners: DutyChange[] = [];
		const bonuses: AttributeBonus[] = [];
		const attrListeners: AttributesChange[] = [];
		let defenseScore = (_h: Hero) => 0;
		let nameFormat = (h: { surname: string; given: string }) => `${h.surname} ${h.given}`;
		let nameGenerator = (_r: () => number, _g: 'm' | 'f') => ({ surname: 'Nameless', given: 'Hero' });
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
		const growth = ctx.config.define('growth', {
			description: 'Levels: experience from L to L+1 = expBase x L^expPower; maxLevel; freePerLevel free points per level up.',
			default: () => RULES.growth as Record<string, number>,
			parse: numberFields(() => RULES.growth as Record<string, number>, 0, 1e9),
		});
		stats.define({ id: 'heroes.candidates', description: 'extra hero candidates', base: () => 0, integer: true, min: 0 });

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
						`INSERT INTO heroes_heroes (id, player_id, surname, given, gender, origin, attrs, home, duty, duty_target, created_at, level, exp, talent, free_points, alloc, talents)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (id) DO UPDATE SET home = excluded.home, duty = excluded.duty, duty_target = excluded.duty_target, attrs = excluded.attrs,
						   level = excluded.level, exp = excluded.exp, free_points = excluded.free_points, alloc = excluded.alloc`,
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
						h.level,
						h.exp,
						h.talent,
						h.freePoints,
						JSON.stringify(h.alloc),
						h.talents ? JSON.stringify(h.talents) : null,
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
			nameOf: (h) => nameFormat(h),
			setNameFormatter: (f) => void (nameFormat = f),
			randomName: (random, gender = 'm') => nameGenerator(random, gender),
			setNameGenerator: (g) => void (nameGenerator = g),
			async attributesOf(api, hero) {
				const out = { ...hero.attrs };
				for (const b of bonuses) for (const [a, n] of Object.entries(await b(api, hero))) out[a] = (out[a] ?? 0) + n;
				return out;
			},
			addAttributeBonus: (b) => void bonuses.push(b),
			onAttributesChange: (l) => void attrListeners.push(l),
			async attributesChanging(api, heroId) {
				const hero = await service.get(api, heroId);
				if (hero) for (const l of attrListeners) await l(api, hero);
			},
			expToNext(api, level) {
				const g = growth.get(api);
				return level >= g.maxLevel ? null : Math.round(g.expBase * level ** g.expPower);
			},
			async grantExp(api, heroId, exp) {
				const hero = await service.get(api, heroId);
				if (!hero) throw new GameError('not_found', 'No such hero', 404);
				if (exp <= 0 || service.expToNext(api, hero.level) === null) return 0;
				for (const l of attrListeners) await l(api, hero);
				const before = hero.level;
				hero.exp += Math.floor(exp);
				for (let need = service.expToNext(api, hero.level); need !== null && hero.exp >= need; need = service.expToNext(api, hero.level)) {
					hero.exp -= need;
					hero.level++;
					levelUp(api, hero);
				}
				if (service.expToNext(api, hero.level) === null) hero.exp = 0;
				write(api, hero);
				return hero.level - before;
			},
			async resetFree(api, heroId) {
				const hero = await service.get(api, heroId);
				if (!hero) throw new GameError('not_found', 'No such hero', 404);
				const spent = Object.values(hero.alloc).reduce((a, b) => a + b, 0);
				if (!spent) throw new GameError('blocked', 'No points to take back');
				for (const l of attrListeners) await l(api, hero);
				for (const [a, n] of Object.entries(hero.alloc)) hero.attrs[a] = (hero.attrs[a] ?? 0) - n;
				hero.freePoints += spent;
				hero.alloc = {};
				write(api, hero);
			},
		};

		/**
		 * One level up: free points, and the talent spread over the attributes weighted by the
		 * hero's natural values (without spent free points), seeded so a retry rolls the same.
		 */
		function levelUp(api: ReadApi, hero: Hero) {
			hero.freePoints += growth.get(api).freePerLevel;
			if (hero.talents) {
				for (const [a, n] of Object.entries(hero.talents)) hero.attrs[a] = (hero.attrs[a] ?? 0) + n;
				return;
			}
			const ids = Object.keys(hero.attrs);
			const weights = ids.map((a) => Math.max(1, (hero.attrs[a] ?? 0) - (hero.alloc[a] ?? 0)));
			const total = weights.reduce((x, y) => x + y, 0);
			const random = seededRandom(`talent:${hero.id}:${hero.level}`);
			for (let i = 0; i < hero.talent; i++) {
				let pick = random() * total;
				let k = 0;
				while (k < ids.length - 1 && pick >= weights[k]) pick -= weights[k++];
				hero.attrs[ids[k]] = (hero.attrs[ids[k]] ?? 0) + 1;
			}
		}
		ctx.services.provide('heroes', service);

		/* ----- recruitment ---------------------------------------------------------------- */

		/** A venue's current offer in a settlement: window, time left and candidates (null = taken or none). */
		async function offer(api: EngineApi, settlementId: string, venue: VenueDef) {
			const level = await buildings.level(api, settlementId, venue.building);
			if (!level) return null;
			const offered = venue.offer(api, level);
			const seconds = offered.seconds;
			// More candidates at every venue of the settlement (e.g. examinations research).
			const count = offered.count + (await stats.get(api, 'heroes.candidates', settlements.entity(settlementId)));
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
			// Candidates the GM placed here: after the regular ones, until recruited.
			const { results: gifts } = await api.db
				.prepare('SELECT id, draft FROM heroes_gifts WHERE settlement_id = ? AND venue = ? ORDER BY created_at, id')
				.bind(settlementId, venue.id)
				.all<{ id: string; draft: string }>();
			return {
				level,
				window,
				refreshesAt: (window + 1) * period,
				candidates,
				taken: [...taken],
				gifts: gifts.map((g) => ({ id: g.id, draft: JSON.parse(g.draft) as HeroDraft })),
			};
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
						candidates: [
							...o.candidates.map((c, slot) => (c ? { slot, ...c } : null)),
							...o.gifts.map((g) => ({ slot: -1, gift: g.id, ...g.draft })),
						],
					});
				}
				return out;
			},
		});

		ctx.commands.add<{ settlement: string; venue: string; slot: number; gift?: string }>({
			type: 'heroes.recruit',
			description:
				'Recruit a candidate. Payload: { "settlement", "venue", "slot" } or, for one the GM placed, { "settlement", "venue", "gift" }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string' || typeof p.venue !== 'string')
					throw new GameError('bad_payload', 'settlement and venue are required');
				if (typeof p.gift === 'string' && p.gift) return { settlement: p.settlement, venue: p.venue, slot: -1, gift: p.gift };
				const slot = Number(p.slot);
				if (!Number.isInteger(slot) || slot < 0) throw new GameError('bad_payload', 'slot must be a whole number');
				return { settlement: p.settlement, venue: p.venue, slot };
			},
			async execute(api, { settlement, venue: venueId, slot, gift }) {
				const s = await settlements.requireOwned(api, settlement);
				const venue = venues.get(venueId);
				if (!venue) throw new GameError('bad_payload', 'Unknown venue');
				const o = await offer(api, s.id, venue);
				if (!o) throw new GameError('blocked', `Requires ${buildings.get(venue.building).name}`);
				const draft = gift ? o.gifts.find((g) => g.id === gift)?.draft : o.candidates[slot];
				if (!draft) throw new GameError('gone', 'That candidate is no longer available');
				const mine = await loadMine(api, api.playerId);
				if (mine.length >= (await stats.get(api, 'heroes.cap', `player:${api.playerId}`)))
					throw new GameError('blocked', 'Hero limit reached');
				// The GM's gifts are free.
				if (!gift) await resources.spend(api, settlements.entity(s.id), venue.cost(api));
				const hero: Hero = {
					id: crypto.randomUUID(),
					playerId: api.playerId,
					surname: draft.surname,
					given: draft.given,
					gender: draft.gender,
					attrs: draft.attrs,
					origin: venue.id,
					home: s.id,
					duty: 'idle',
					dutyTarget: null,
					createdAt: api.now,
					level: 1,
					exp: 0,
					talent: draft.talents ? Object.values(draft.talents).reduce((a, b) => a + b, 0) : (draft.talent ?? 3),
					talents: draft.talents ?? null,
					freePoints: 0,
					alloc: {},
				};
				mine.push(hero);
				write(api, hero);
				// The primary key keeps a candidate from being recruited twice, even by commands racing
				// (a gift: the player lock does, as only its player can recruit it).
				api.write(
					gift
						? api.db.prepare('DELETE FROM heroes_gifts WHERE id = ?').bind(gift)
						: api.db
								.prepare('INSERT INTO heroes_taken (settlement_id, venue, win, slot) VALUES (?, ?, ?, ?)')
								.bind(s.id, venue.id, o.window, slot),
				);
			},
		});

		// The GM places a candidate at a player's venue: random, or with chosen attributes (partial).
		ctx.commands.add<{ settlement: string; venue: string; attrs: Record<string, number> }>({
			type: 'heroes.gift',
			privileged: true,
			description:
				'Place a candidate at one of the player\'s recruiting buildings, free to recruit. Payload: { "settlement", "venue", "attrs"?: { "<attribute>": n } } (attributes not given are rolled).',
			form: {
				title: 'Place a hero candidate',
				placement: 'gm',
				fields: [{ name: 'target', label: 'Where', type: 'select', required: true }],
				submitLabel: 'Place',
				async prepare(api) {
					const options: { value: string; label: string }[] = [];
					for (const s of await settlements.mine(api, api.playerId))
						for (const v of venues.values())
							if (await buildings.level(api, s.id, v.building)) options.push({ value: `${s.id}|${v.id}`, label: `${s.name} · ${v.name}` });
					// One box per attribute (content defines them after this form is declared).
					const fields = [...attributes.values()].map((a) => ({
						name: `attrs.${a.id}`,
						label: `${a.name} (empty = random)`,
						type: 'number' as const,
						min: 0,
					}));
					return options.length ? { options: { target: options }, fields } : false;
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				const [settlement, venue] = typeof p.target === 'string' ? p.target.split('|') : [p.settlement, p.venue];
				if (typeof settlement !== 'string' || typeof venue !== 'string')
					throw new GameError('bad_payload', 'settlement and venue are required');
				const nested = { ...((p.attrs ?? {}) as Record<string, unknown>) };
				for (const [k, v] of Object.entries(p)) if (k.startsWith('attrs.')) nested[k.slice(6)] = v;
				const attrs: Record<string, number> = {};
				for (const [a, v] of Object.entries(nested)) {
					if (v === '' || v === undefined || v === null) continue;
					if (!attributes.has(a)) throw new GameError('bad_payload', `Unknown attribute "${a}"`);
					attrs[a] = Math.round(numberInRange(0, 1e6)(v));
				}
				return { settlement, venue, attrs };
			},
			async execute(api, { settlement, venue: venueId, attrs }) {
				const s = await settlements.requireOwned(api, settlement);
				const venue = venues.get(venueId);
				if (!venue) throw new GameError('bad_payload', 'Unknown venue');
				if (!(await buildings.level(api, s.id, venue.building)))
					throw new GameError('blocked', `Requires ${buildings.get(venue.building).name}`);
				// Rare venues often roll nobody: try until someone turns up.
				let draft: HeroDraft | null = null;
				for (let i = 0; i < 1000 && !draft; i++) draft = venue.draft(api, seededRandom(`gift:${crypto.randomUUID()}`), 0);
				if (!draft) throw new GameError('blocked', 'Could not roll a candidate here');
				draft.attrs = { ...draft.attrs, ...attrs };
				api.write(
					api.db
						.prepare('INSERT INTO heroes_gifts (id, settlement_id, venue, draft, created_at) VALUES (?, ?, ?, ?, ?)')
						.bind(crypto.randomUUID(), s.id, venue.id, JSON.stringify(draft), api.now),
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
				// Away on a duty only another plugin ends (leading an army, adventuring, injured...): it stays put.
				if (!service.duty((await owned(api, heroId)).duty).manual) throw new GameError('blocked', 'The hero is busy');
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

		ctx.commands.add<{ hero: string; points: Record<string, number> }>({
			type: 'heroes.allocate',
			description: 'Spend free points on attributes. Payload: { "hero", "points": { "<attribute>": n, ... } }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.hero !== 'string' || typeof p.points !== 'object' || p.points === null)
					throw new GameError('bad_payload', 'hero and points are required');
				const points: Record<string, number> = {};
				for (const [a, n] of Object.entries(p.points as Record<string, unknown>)) {
					if (!attributes.has(a)) throw new GameError('bad_payload', `Unknown attribute "${a}"`);
					if (!Number.isInteger(n) || (n as number) < 0) throw new GameError('bad_payload', 'Points must be whole numbers');
					if (n) points[a] = n as number;
				}
				if (!Object.keys(points).length) throw new GameError('bad_payload', 'No points given');
				return { hero: p.hero, points };
			},
			async execute(api, { hero: heroId, points }) {
				const hero = await owned(api, heroId);
				const total = Object.values(points).reduce((a, b) => a + b, 0);
				if (total > hero.freePoints) throw new GameError('blocked', `Only ${hero.freePoints} free points`);
				for (const l of attrListeners) await l(api, hero);
				for (const [a, n] of Object.entries(points)) {
					hero.attrs[a] = (hero.attrs[a] ?? 0) + n;
					hero.alloc[a] = (hero.alloc[a] ?? 0) + n;
				}
				hero.freePoints -= total;
				write(api, hero);
			},
		});

		ctx.commands.add<{ hero: string; exp: number }>({
			type: 'heroes.grantExp',
			privileged: true,
			description: 'Give a hero experience. Payload: { "hero", "exp": 1000 }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.hero !== 'string') throw new GameError('bad_payload', 'hero is required');
				return { hero: p.hero, exp: Math.floor(numberInRange(1, 1e9)(p.exp)) };
			},
			async execute(api, { hero, exp }) {
				await owned(api, hero);
				await service.grantExp(api, hero, exp);
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
				const out: HeroInfo[] = [];
				for (const { playerId: _, createdAt: __, ...h } of await loadMine(api, api.playerId)) {
					const all = await service.attributesOf(api, h as Hero);
					const bonus = Object.fromEntries(
						Object.entries(all).flatMap(([a, n]) => (n !== (h.attrs[a] ?? 0) ? [[a, n - (h.attrs[a] ?? 0)]] : [])),
					);
					out.push({ ...h, expToNext: service.expToNext(api, h.level), bonus });
				}
				return out;
			},
		});

		ctx.meta.add('heroes', () => ({
			attributes: service.attributes(),
			duties: [...duties.values()].map(({ id, name, inTown, manual, anywhere }) => ({ id, name, inTown, manual, anywhere: !!anywhere })),
			venues: [...venues.values()].map(({ id, name, building }) => ({ id, name, building })),
		}));

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.page({ id: 'heroes', label: 'Heroes', order: 6 });
		ui.block({ page: 'heroes', column: 'left', widget: 'heroes.list' });
		ui.block({ page: 'heroes', column: 'right', widget: 'heroes.candidates' });
		ui.block({ page: 'heroes', column: 'right', widget: 'heroes.defense', order: 10 });
		// Posts: the city page shows the settlement's own; buildings with posts (e.g. the institute) show theirs.
		ui.block({ page: 'city', column: 'left', widget: 'heroes.posts', order: 20 });
		ui.entry({ kind: 'building', widget: 'heroes.posts' });
		ui.entry({ kind: 'building', widget: 'heroes.candidates', types: () => [...venues.values()].map((v) => v.building) });
	},
});
