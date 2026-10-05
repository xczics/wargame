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
	type EngineApi,
	fields,
	gameErrors,
	numberFields,
	numberInRange,
	PluginError,
	type ReadApi,
	seededRandom,
	shape,
} from '../../kernel';
import type { HeroCandidates, HeroInfo } from '../../shared/api';
import { amounts } from '../../shared/format';
import type { CardsData, RowsData, UiCard, UiLine, UiText } from '../../shared/ui';
import type { Cost } from '../resources';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, uiTexts } from '../../shared/i18n';

const fail = gameErrors('heroes');
const text = uiTexts('heroes');

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
	/**
	 * Roll one candidate with the given random numbers, or null (none in this slot this time). `level`: the
	 * building's level when this round of candidates came (an upgrade during the round counts from the next).
	 */
	draft(api: ReadApi, random: () => number, slot: number, level: number): HeroDraft | null;
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
	check?(api: EngineApi, hero: Hero, target: string | null): Promise<UiText | null>;
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
	/** One of `playerId`'s heroes; refused ("No such hero", ours) otherwise: callers never word it themselves. */
	requireOwned(api: ReadApi, playerId: string, heroId: string): Promise<Hero>;
	/** Refused ("The hero is busy", ours) unless the hero is on a duty it can leave at will (e.g. idle, governor). */
	requireFree(hero: Hero): void;
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
	/**
	 * A hero's name as sent to the client: its name-part keys ("s:Wang m:Rui"), which the client spells for its
	 * language. Never spell names on the server: a text holding one would be in one language only.
	 */
	nameKey(hero: { surname: string; given: string }): string;
	/** More lines on a hero's card (`heroes.cards`), e.g. what it gives in each role, its adventure numbers. Must only read. */
	addCardLines(lines: (api: EngineApi, hero: Hero) => Promise<UiLine[]>): void;
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
	/** Give one of `playerId`'s heroes a name of the player's own (kept as typed; `NAME_MAX` characters at most). */
	rename(api: EngineApi, playerId: string, heroId: string, name: string): Promise<void>;
	/** Put one more candidate at a venue of a settlement (rolled there; `attrs` fixed), until recruited. */
	placeCandidate(api: EngineApi, settlementId: string, venue: string, attrs?: Record<string, number>): Promise<void>;
	/** Roll a venue's regular candidates again now (its timer goes on as before). False if it is not built. */
	refreshCandidates(api: EngineApi, settlementId: string, venue: string): Promise<boolean>;
	/** The venues (recruiting buildings), e.g. for items that act on one. */
	venues(): readonly VenueDef[];
	/** Longest name a player may give a hero (characters). */
	readonly nameMax: number;
}

const NAME_MAX = 12;

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
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const settlements = ctx.services.get('settlements');
		const buildings = ctx.services.get('buildings');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const attributes = new Map<string, AttributeDef>();
		const cardLines: ((api: EngineApi, hero: Hero) => Promise<UiLine[]>)[] = [];
		const venues = new Map<string, VenueDef>();
		const duties = new Map<string, DutyDef>();
		const listeners: DutyChange[] = [];
		const bonuses: AttributeBonus[] = [];
		const attrListeners: AttributesChange[] = [];
		let defenseScore = (_h: Hero) => 0;
		// A name the player gave is one part, "n:<encoded>" (no given name): the client shows it as typed.
		const nameKey = (h: { surname: string; given: string }) => (h.given ? `${h.surname} ${h.given}` : h.surname);
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
			api.memo(
				`heroes:mine:${playerId}`,
				async () => {
					const { results } = await api.db
						.prepare('SELECT * FROM heroes_heroes WHERE player_id = ? ORDER BY created_at')
						.bind(playerId)
						.all<Row>();
					return results.map(toHero);
				},
				{ current: true },
			);
		const write = (api: EngineApi, h: Hero) =>
			api.write(
				api.db
					.prepare(
						`INSERT INTO heroes_heroes (id, player_id, surname, given, gender, origin, attrs, home, duty, duty_target, created_at, level, exp, talent, free_points, alloc, talents)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (id) DO UPDATE SET surname = excluded.surname, given = excluded.given,
						   home = excluded.home, duty = excluded.duty, duty_target = excluded.duty_target, attrs = excluded.attrs,
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

		duties.set('idle', { id: 'idle', name: 'heroes.Idle', inTown: true, manual: true });

		const service: HeroesService = {
			defineAttribute(def) {
				if (attributes.has(def.id)) throw new PluginError(`Hero attribute "${def.id}" defined twice`);
				attributes.set(def.id, { ...def, name: ctx.services.get('i18n').own(def.name) });
			},
			attributes: () => [...attributes.values()],
			defineVenue(def) {
				if (venues.has(def.id)) throw new PluginError(`Hero venue "${def.id}" defined twice`);
				venues.set(def.id, { ...def, name: ctx.services.get('i18n').own(def.name) });
			},
			defineDuty(def) {
				if (duties.has(def.id)) throw new PluginError(`Hero duty "${def.id}" defined twice`);
				duties.set(def.id, { ...def, name: ctx.services.get('i18n').own(def.name) });
			},
			duty(id) {
				const d = duties.get(id);
				if (!d) throw fail('bad_payload', text('Unknown duty "{0}"', { 0: id }));
				return d;
			},
			list: (api, playerId) => loadMine(api, playerId),
			async requireOwned(api, playerId, heroId) {
				const hero = (await loadMine(api, playerId)).find((h) => h.id === heroId);
				if (!hero) throw fail('not_found', 'No such hero', 404);
				return hero;
			},
			requireFree(hero) {
				if (!service.duty(hero.duty).manual) throw fail('blocked', 'The hero is busy');
			},
			async get(api, id) {
				// Mostly the acting player's own heroes (loaded once per call); others: their owner looked up once.
				const mine = (await loadMine(api, api.playerId)).find((h) => h.id === id);
				if (mine) return mine;
				const owner = await api.memo(`heroes:owner:${id}`, async () => {
					const row = await api.db.prepare('SELECT player_id FROM heroes_heroes WHERE id = ?').bind(id).first<{ player_id: string }>();
					return row?.player_id ?? null;
				});
				return owner ? ((await loadMine(api, owner)).find((h) => h.id === id) ?? null) : null;
			},
			async onDuty(api, duty, target) {
				const owners = await api.memo(`heroes:owners:${duty}:${target}`, async () => {
					// A settlement made in this call has nobody on duty for it yet.
					if (api.isFresh(`settlement:${target}`)) return [] as string[];
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
				if (!hero) throw fail('not_found', 'No such hero', 404);
				const duty = service.duty(dutyId);
				if (dutyId !== 'idle' && !duty.anywhere && target !== hero.home)
					throw fail('blocked', 'A hero serves only in the settlement it is attached to');
				const reason = dutyId === 'idle' ? null : await duty.check?.(api, hero, target);
				if (reason) throw fail('blocked', reason);
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
				if (!hero || !s || s.ownerId !== hero.playerId) throw fail('not_found', 'No such hero or settlement', 404);
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
			nameKey,
			addCardLines: (l) => void cardLines.push(l),
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
				if (!hero) throw fail('not_found', 'No such hero', 404);
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
				if (!hero) throw fail('not_found', 'No such hero', 404);
				const spent = Object.values(hero.alloc).reduce((a, b) => a + b, 0);
				if (!spent) throw fail('blocked', 'No points to take back');
				for (const l of attrListeners) await l(api, hero);
				for (const [a, n] of Object.entries(hero.alloc)) hero.attrs[a] = (hero.attrs[a] ?? 0) - n;
				hero.freePoints += spent;
				hero.alloc = {};
				write(api, hero);
			},
			async rename(api, playerId, heroId, name) {
				const hero = await service.requireOwned(api, playerId, heroId);
				const clean = name.trim();
				if (!clean || [...clean].length > NAME_MAX) throw fail('bad_payload', text('A name has 1 to {0} characters', { 0: NAME_MAX }));
				hero.surname = `n:${encodeURIComponent(clean)}`;
				hero.given = '';
				write(api, hero);
			},
			async placeCandidate(api, settlementId, venueId, attrs = {}) {
				const venue = venues.get(venueId);
				if (!venue) throw fail('bad_payload', 'Unknown venue');
				if (!(await buildings.level(api, settlementId, venue.building)))
					throw fail('blocked', text('Requires {0}', { 0: keyText(buildings.get(venue.building).name) }));
				// Rare venues often roll nobody: try until someone turns up.
				let draft: HeroDraft | null = null;
				const level = await buildings.level(api, settlementId, venue.building);
				for (let i = 0; i < 1000 && !draft; i++) draft = venue.draft(api, seededRandom(`gift:${crypto.randomUUID()}`), 0, level);
				if (!draft) throw fail('blocked', 'Could not roll a candidate here');
				draft.attrs = { ...draft.attrs, ...attrs };
				api.write(
					api.db
						.prepare('INSERT INTO heroes_gifts (id, settlement_id, venue, draft, created_at) VALUES (?, ?, ?, ?, ?)')
						.bind(crypto.randomUUID(), settlementId, venue.id, JSON.stringify(draft), api.now),
				);
			},
			async refreshCandidates(api, settlementId, venueId) {
				const venue = venues.get(venueId);
				if (!venue) throw fail('bad_payload', 'Unknown venue');
				const level = await buildings.level(api, settlementId, venue.building);
				if (!level) return false;
				const window = Math.floor(api.now / periodOf(api, venue, level));
				const r = inWindow(await loadRefresh(api, settlementId, venue.id), window);
				r.salt += 1;
				r.level = null; // rolled again now: at the level now
				writeRefresh(api, settlementId, venue.id, r);
				// All new faces: none of them taken yet.
				api.write(
					api.db.prepare('DELETE FROM heroes_taken WHERE settlement_id = ? AND venue = ? AND win = ?').bind(settlementId, venue.id, window),
				);
				return true;
			},
			venues: () => [...venues.values()],
			nameMax: NAME_MAX,
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

		/**
		 * A venue's latest window with something to remember: how often its candidates were rolled again (salt, 0: as
		 * they come) and the building level they are rolled at when it went up during that window (null: the level now).
		 */
		type Refresh = { win: number; salt: number; level: number | null };
		const loadRefresh = (api: ReadApi, settlementId: string, venue: string) =>
			api.memo(`heroes:refresh:${settlementId}:${venue}`, async (): Promise<Refresh> => {
				const row = await api.db
					.prepare('SELECT win, salt, level FROM heroes_refresh WHERE settlement_id = ? AND venue = ?')
					.bind(settlementId, venue)
					.first<Refresh>();
				return row ?? { win: -1, salt: 0, level: null };
			});
		/** The same record moved to `window` (a new window starts with nothing to remember). */
		const inWindow = (r: Refresh, window: number) => {
			if (r.win !== window) Object.assign(r, { win: window, salt: 0, level: null });
			return r;
		};
		const writeRefresh = (api: EngineApi, settlementId: string, venue: string, r: Refresh) =>
			api.write(
				api.db
					.prepare(
						`INSERT INTO heroes_refresh (settlement_id, venue, win, salt, level) VALUES (?, ?, ?, ?, ?)
						 ON CONFLICT (settlement_id, venue) DO UPDATE SET win = excluded.win, salt = excluded.salt, level = excluded.level`,
					)
					.bind(settlementId, venue, r.win, r.salt, r.level),
			);
		/** The length of a venue's window here (its offer's period). */
		const periodOf = (api: ReadApi, venue: VenueDef, level: number) => Math.max(60, venue.offer(api, level).seconds) * 1000;

		// Candidates keep the level their round began with (user 2026-10-05: "按刷新时的建筑等级判定，而非招募时"). An
		// upgrade that changes the window length starts a new round anyway; one that does not (the shortest window)
		// leaves this round at the old level.
		buildings.onLevelChanged(async (api, { settlementId, building, from, to, at }) => {
			if (!from) return;
			for (const venue of venues.values()) {
				if (venue.building !== building) continue;
				const period = periodOf(api, venue, from);
				if (period !== periodOf(api, venue, to)) continue;
				const r = inWindow(await loadRefresh(api, settlementId, venue.id), Math.floor(at / period));
				r.level ??= from;
				writeRefresh(api, settlementId, venue.id, r);
			}
		});

		/** A venue's current offer in a settlement: window, time left and candidates (null = taken or none). */
		async function offer(api: EngineApi, settlementId: string, venue: VenueDef) {
			const level = await buildings.level(api, settlementId, venue.building);
			if (!level) return null;
			const offered = venue.offer(api, level);
			// More candidates at every venue of the settlement (e.g. examinations research).
			const count = offered.count + (await stats.get(api, 'heroes.candidates', settlements.entity(settlementId)));
			const period = periodOf(api, venue, level);
			const window = Math.floor(api.now / period);
			const { results } = await api.db
				.prepare('SELECT slot FROM heroes_taken WHERE settlement_id = ? AND venue = ? AND win = ?')
				.bind(settlementId, venue.id, window)
				.all<{ slot: number }>();
			const taken = new Set(results.map((r) => r.slot));
			// Rolled again this window (an item): another seed; upgraded during it: still at the level it began with.
			const r = await loadRefresh(api, settlementId, venue.id);
			const salt = r.win === window ? r.salt : 0;
			const rolledAt = r.win === window && r.level !== null ? r.level : level;
			const seed = (slot: number) => `hero:${settlementId}:${venue.id}:${window}:${slot}${salt ? `:r${salt}` : ''}`;
			const candidates = Array.from({ length: count }, (_, slot) =>
				taken.has(slot) ? null : venue.draft(api, seededRandom(seed(slot)), slot, rolledAt),
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

		// The candidates as generic cards: a section per venue (when it renews), a card per slot; on a
		// venue's building entry only its own ("building:<type>").
		// Candidates change with commands and with each venue's window (time): both in the stamp.
		ctx.views.add({
			id: 'heroes.candidate-cards',
			async stamp(api, params) {
				const s = await settlements.resolve(api, params).catch(() => null);
				const windows: number[] = [];
				for (const v of s ? venues.values() : []) {
					const level = await buildings.level(api, s!.id, v.building);
					windows.push(level ? Math.floor(api.now / periodOf(api, v, level)) : 0);
				}
				return `${await settlements.stamp(api, params)}|${windows.join(',')}`;
			},
			async compute(api, params): Promise<CardsData> {
				const s = await settlements.resolve(api, params);
				const icons = Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id]));
				const groups: NonNullable<CardsData['groups']> = [];
				const cards: UiCard[] = [];
				for (const v of s ? venues.values() : []) {
					const o = await offer(api, s!.id, v);
					if (!o) continue;
					const cost = v.cost(api);
					const affordable = await resources.canAfford(api, settlements.entity(s!.id), cost);
					groups.push({
						id: v.id,
						label: keyText(v.name),
						lines: [{ text: text('New candidates in'), tone: 'muted', endsAt: o.refreshesAt }],
					});
					const where = ['page:heroes', `building:${v.building}`];
					const list = [
						...o.candidates.map((c, slot) => ({ c, slot, gift: undefined as string | undefined })),
						...o.gifts.map((g) => ({ c: g.draft, slot: -1, gift: g.id })),
					];
					for (const [i, { c, slot, gift }] of list.entries()) {
						const id = `${v.id}/${gift ?? i}`;
						if (!c) {
							cards.push({ id, group: v.id, where, title: text(o.taken.includes(i) ? 'Recruited' : 'Nobody this time') });
							continue;
						}
						cards.push({
							id,
							group: v.id,
							where,
							icon: c.gender === 'f' ? '👸' : '🧔',
							title: keyText(nameKey(c)),
							lines: [
								{
									text: text(''),
									parts: [...attributes.values()].map((a) => ({
										text: text(c.talents?.[a.id] ? '{0} {1} ▲{2}' : '{0} {1}', {
											0: keyText(a.name),
											1: c.attrs[a.id] ?? 0,
											2: c.talents?.[a.id] ?? 0,
										}),
									})),
								},
							],
							actions: [
								{
									command: 'heroes.recruit',
									payload: gift ? { settlement: s!.id, venue: v.id, gift } : { settlement: s!.id, venue: v.id, slot },
									label: text('Recruit · {0}', { 0: amounts(cost, icons) }),
									...(affordable ? {} : { blocked: text('Not enough resources') }),
								},
							],
						});
					}
				}
				return { groups, cards, empty: text('No recruiting buildings here.') };
			},
		});

		ctx.commands.add<{ settlement: string; venue: string; slot: number; gift?: string }>({
			type: 'heroes.recruit',
			description:
				'Recruit a candidate. Payload: { "settlement", "venue", "slot" } or, for one the GM placed, { "settlement", "venue", "gift" }',
			// A candidate's slot, or a gift (a hero promised by an item) instead.
			parse: shape(
				{ settlement: fields.id(), venue: fields.id(), slot: fields.optional(fields.int(0, 1000)), gift: fields.optional(fields.id()) },
				({ settlement, venue, slot, gift }) => {
					if (gift) return { settlement, venue, slot: -1, gift };
					if (slot === undefined) throw fail('bad_payload', 'slot must be a whole number');
					return { settlement, venue, slot };
				},
			),
			async execute(api, { settlement, venue: venueId, slot, gift }) {
				const s = await settlements.requireOwned(api, settlement);
				const venue = venues.get(venueId);
				if (!venue) throw fail('bad_payload', 'Unknown venue');
				const o = await offer(api, s.id, venue);
				if (!o) throw fail('blocked', text('Requires {0}', { 0: keyText(buildings.get(venue.building).name) }));
				const draft = gift ? o.gifts.find((g) => g.id === gift)?.draft : o.candidates[slot];
				if (!draft) throw fail('gone', 'That candidate is no longer available');
				const mine = await loadMine(api, api.playerId);
				if (mine.length >= (await stats.get(api, 'heroes.cap', `player:${api.playerId}`))) throw fail('blocked', 'Hero limit reached');
				// Placed candidates (the GM's, an item's) cost what any candidate does.
				await resources.spend(api, settlements.entity(s.id), venue.cost(api));
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
				'Place a candidate at one of the player\'s recruiting buildings (recruited at the usual price). Payload: { "settlement", "venue", "attrs"?: { "<attribute>": n } } (attributes not given are rolled).',
			form: {
				title: text('Place a hero candidate'),
				placement: 'gm',
				fields: [{ name: 'target', label: text('Where'), type: 'select', required: true }],
				submitLabel: text('Place'),
				async prepare(api) {
					const options: { value: string; label: UiText }[] = [];
					for (const s of await settlements.mine(api, api.playerId))
						for (const v of venues.values())
							if (await buildings.level(api, s.id, v.building))
								options.push({ value: `${s.id}|${v.id}`, label: text('{0} · {1}', { 0: settlements.nameText(s), 1: keyText(v.name) }) });
					// One box per attribute (content defines them after this form is declared).
					const fields = [...attributes.values()].map((a) => ({
						name: `attrs.${a.id}`,
						label: text('{0} (empty = random)', { 0: keyText(a.name) }),
						type: 'number' as const,
						min: 0,
					}));
					return options.length ? { options: { target: options }, fields } : false;
				},
			},
			// The form's select gives "<settlement>|<venue>"; empty attributes are rolled.
			parse: shape(
				{
					target: fields.optional(fields.text({ max: 300 })),
					settlement: fields.optional(fields.id()),
					venue: fields.optional(fields.id()),
					attrs: fields.orElse(fields.record(fields.optional(fields.number(0, 1e6)), { keys: () => [...attributes.keys()] }), {}),
				},
				(p) => {
					const [settlement, venue] = p.target ? p.target.split('|') : [p.settlement, p.venue];
					if (!settlement || !venue) throw fail('bad_payload', 'settlement and venue are required');
					const attrs = Object.fromEntries(Object.entries(p.attrs).flatMap(([a, v]) => (v === undefined ? [] : [[a, Math.round(v)]])));
					return { settlement, venue, attrs };
				},
			),
			async execute(api, { settlement, venue, attrs }) {
				const s = await settlements.requireOwned(api, settlement);
				await service.placeCandidate(api, s.id, venue, attrs);
			},
		});

		/* ----- managing heroes ------------------------------------------------------------ */

		const owned = (api: EngineApi, heroId: string) => service.requireOwned(api, api.playerId, heroId);

		ctx.commands.add<{ hero: string; duty: string; target: string | null }>({
			type: 'heroes.assign',
			description: 'Put a hero on a duty ("idle" to free it). Payload: { "hero", "duty", "target": "<settlement>" }',
			// On the hero's card: duties are held where it is attached.
			form: {
				title: text('Duty'),
				placement: 'hero',
				fields: [
					{ name: 'hero', label: text('Hero'), type: 'hidden' },
					{ name: 'target', label: text('At'), type: 'hidden' },
					{ name: 'duty', label: text('Duty'), type: 'select', required: true },
				],
				submitLabel: text('Assign'),
				async prepare(api, params) {
					const hero = (await loadMine(api, api.playerId)).find((h) => h.id === params.hero);
					if (!hero || !service.duty(hero.duty).manual) return false;
					return {
						defaults: { hero: hero.id, target: hero.home, duty: hero.duty },
						options: { duty: [...duties.values()].filter((d) => d.manual).map((d) => ({ value: d.id, label: keyText(d.name) })) },
					};
				},
			},
			parse: shape({ hero: fields.id(), duty: fields.id(), target: fields.orElse<string | null>(fields.id(), null) }),
			async execute(api, { hero: heroId, duty, target }) {
				const hero = await owned(api, heroId);
				if (!service.duty(duty).manual) throw fail('blocked', 'That duty is not chosen this way');
				service.requireFree(hero);
				if (target) await settlements.requireOwned(api, target);
				await service.assign(api, hero.id, duty, duty === 'idle' ? null : target);
			},
		});

		ctx.commands.add<{ hero: string; settlement: string }>({
			type: 'heroes.setHome',
			description: 'Attach a hero to another of your settlements. Payload: { "hero", "settlement" }',
			form: {
				title: text('Attached to'),
				placement: 'hero',
				fields: [
					{ name: 'hero', label: text('Hero'), type: 'hidden' },
					{ name: 'settlement', label: text('Settlement'), type: 'select', required: true },
				],
				submitLabel: text('Move'),
				async prepare(api, params) {
					const hero = (await loadMine(api, api.playerId)).find((h) => h.id === params.hero);
					if (!hero || !service.duty(hero.duty).manual) return false;
					const post = service.duty(hero.duty);
					return {
						defaults: { hero: hero.id, settlement: hero.home },
						options: { settlement: (await settlements.mine(api, api.playerId)).map((x) => ({ value: x.id, label: keyText(x.name) })) },
						...(hero.duty !== 'idle' && !post.anywhere
							? { description: text('Moving ends the post of {0}.', { 0: keyText(post.name) }) }
							: {}),
					};
				},
			},
			parse: shape({ hero: fields.id(), settlement: fields.id() }),
			async execute(api, { hero: heroId, settlement }) {
				// Away on a duty only another plugin ends (leading an army, adventuring, injured...): it stays put.
				service.requireFree(await owned(api, heroId));
				await settlements.requireOwned(api, settlement);
				await service.setHome(api, heroId, settlement);
			},
		});

		ctx.commands.add<{ hero: string }>({
			type: 'heroes.dismiss',
			description: 'Let an idle hero go. Payload: { "hero" }',
			form: {
				title: text('Dismiss'),
				placement: 'hero',
				fields: [{ name: 'hero', label: text('Hero'), type: 'hidden' }],
				submitLabel: text('Dismiss'),
				confirm: text('Let this hero go?'),
				async prepare(api, params) {
					const hero = (await loadMine(api, api.playerId)).find((h) => h.id === params.hero);
					return hero?.duty === 'idle' ? { defaults: { hero: hero.id } } : false;
				},
			},
			parse: shape({ hero: fields.id() }),
			async execute(api, { hero: heroId }) {
				const hero = await owned(api, heroId);
				if (hero.duty !== 'idle') throw fail('blocked', 'Only idle heroes can be dismissed');
				const mine = await loadMine(api, api.playerId);
				mine.splice(mine.indexOf(hero), 1);
				api.write(api.db.prepare('DELETE FROM heroes_heroes WHERE id = ?').bind(hero.id));
			},
		});

		ctx.commands.add<{ hero: string; points: Record<string, number> }>({
			type: 'heroes.allocate',
			description: 'Spend free points on attributes. Payload: { "hero", "points": { "<attribute>": n, ... } }',
			// On the hero's card while it has free points: one number per attribute, adding up to at most those points.
			form: {
				title: text('Spend points'),
				placement: 'hero',
				fields: [
					{ name: 'hero', label: text('Hero'), type: 'hidden' },
					{ name: 'free', label: text('Free points'), type: 'hidden' },
				],
				submitLabel: text('Spend points'),
				async prepare(api, params) {
					const hero = (await loadMine(api, api.playerId)).find((h) => h.id === params.hero);
					if (!hero?.freePoints) return false;
					// A row per attribute: where its value comes from (attrs = base + talent per level gained + points;
					// bonuses on top). Heroes from before the talent split grew at random: no talent column for them.
					const total = await service.attributesOf(api, hero);
					const fields = [...attributes.values()].map((a) => {
						const own = hero.attrs[a.id] ?? 0;
						const talent = hero.talents ? (hero.talents[a.id] ?? 0) * (hero.level - 1) : 0;
						const spent = hero.alloc[a.id] ?? 0;
						return {
							name: `points.${a.id}`,
							label: keyText(a.name),
							type: 'number' as const,
							min: 0,
							placeholder: text('0'),
							cells: [
								Math.round(total[a.id] ?? 0),
								own - talent - spent,
								hero.talents ? talent : '–',
								Math.round((total[a.id] ?? 0) - own),
								spent,
							],
						};
					});
					return {
						fields,
						columns: [text('Attribute'), text('Total'), text('Base'), text('Talent'), text('Bonus'), text('Points'), text('Add')],
						defaults: { hero: hero.id, free: hero.freePoints },
						budgets: [{ label: text('Free points'), use: fields.map((f) => f.name), capacity: { free: 1 } }],
					};
				},
			},
			// `points.<attribute>` fields (its form) or a `points` object.
			parse: shape(
				{ hero: fields.id(), points: fields.record(fields.orElse(fields.int(0, 1e6), 0), { keys: () => [...attributes.keys()] }) },
				({ hero, points }) => {
					const given = Object.fromEntries(Object.entries(points).filter(([, n]) => n > 0));
					if (!Object.keys(given).length) throw fail('bad_payload', 'No points given');
					return { hero, points: given };
				},
			),
			async execute(api, { hero: heroId, points }) {
				const hero = await owned(api, heroId);
				const total = Object.values(points).reduce((a, b) => a + b, 0);
				if (total > hero.freePoints) throw fail('blocked', text('Only {0} free points', { 0: hero.freePoints }));
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
			parse: shape({ hero: fields.id(), exp: fields.int(1, 1e9) }),
			async execute(api, { hero, exp }) {
				await owned(api, hero);
				await service.grantExp(api, hero, exp);
			},
		});

		ctx.commands.add<{ settlement: string; heroes: string[] }>({
			type: 'heroes.setDefenseOrder',
			description:
				'Order the heroes defending a settlement (from those attached to it; more than the limit = substitutes). Payload: { "settlement", "heroes": ["<id>", ...] }; [] = back to strongest first.',
			parse: shape({ settlement: fields.id(), heroes: fields.list(fields.id(), { min: 0 }) }, (p) => ({
				...p,
				heroes: [...new Set(p.heroes)],
			})),
			async execute(api, { settlement, heroes: ids }) {
				await settlements.requireOwned(api, settlement);
				const mine = await loadMine(api, api.playerId);
				for (const id of ids)
					if (mine.find((h) => h.id === id)?.home !== settlement)
						throw fail('bad_payload', 'Only heroes attached to this settlement can defend it');
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

		// The defence order for the generic rows widget: each ↑ / ↓ saves the order with that swap at once.
		ctx.views.add({
			id: 'heroes.defense-rows',
			stamp: (api, params) => settlements.stamp(api, params),
			async compute(api, params): Promise<RowsData | null> {
				const s = await settlements.resolve(api, params);
				if (!s) return null;
				const attached = (await loadMine(api, api.playerId)).filter((h) => h.home === s.id);
				const saved = (await loadOrder(api, s.id)).heroes;
				const ids = attached.map((h) => h.id);
				const order = [...(saved ?? []).filter((id) => ids.includes(id)), ...ids.filter((id) => !(saved ?? []).includes(id))];
				const byId = new Map(attached.map((h) => [h.id, h]));
				const swapped = (i: number, j: number) => {
					const next = [...order];
					[next[i], next[j]] = [next[j], next[i]];
					return { command: 'heroes.setDefenseOrder', payload: { settlement: s.id, heroes: next } };
				};
				const edge = text('—');
				return {
					title: text('Defence order'),
					sections: [
						{
							rows: [
								...order.map((id, i) => ({
									id,
									title: text('{n}. {hero}', { n: i + 1, hero: nameKey(byId.get(id)!) }),
									actions: [
										{ ...swapped(i, i - 1), label: text('↑'), ...(i === 0 ? { blocked: edge } : {}) },
										{ ...swapped(i, i + 1), label: text('↓'), ...(i === order.length - 1 ? { blocked: edge } : {}) },
									],
								})),
								...(saved
									? [
											{
												id: 'reset',
												title: text('Strongest first'),
												actions: [{ command: 'heroes.setDefenseOrder', payload: { settlement: s.id, heroes: [] }, label: text('Reset') }],
											},
										]
									: []),
							],
							lines: attached.length
								? saved
									? []
									: [{ text: text('Strongest first (not set).'), tone: 'muted' as const }]
								: [{ text: text('No heroes attached here.'), tone: 'muted' as const }],
						},
					],
					notes: [
						{ text: text('The first heroes here that are in town defend this settlement; the rest are substitutes.'), tone: 'muted' },
					],
				};
			},
		});

		// The Heroes page's list (generic `ui.cards`): the heroes attached to the selected settlement, each
		// with its level, duty, experience, attributes and what other plugins add; "Manage" opens its forms
		// (placement "hero": duty, attachment, free points, dismissal).
		// Heroes change with the player's commands and their adventures' events (on their home settlement): its stamp.
		ctx.views.add({
			id: 'heroes.cards',
			stamp: (api, params) => settlements.stamp(api, params),
			async compute(api, params): Promise<CardsData | null> {
				const s = await settlements.resolve(api, params);
				if (!s) return null;
				const all = await loadMine(api, api.playerId);
				const here = all.filter((h) => h.home === s.id);
				const names = new Map((await settlements.mine(api, api.playerId)).map((x) => [x.id, settlements.nameText(x)]));
				const cards: UiCard[] = [];
				for (const h of here) {
					const attrs = await service.attributesOf(api, h);
					const need = service.expToNext(api, h.level);
					const duty = service.duty(h.duty);
					const lines: UiLine[] = [
						{
							text:
								h.dutyTarget && names.has(h.dutyTarget)
									? text('Lv {0} · {1} · {2}', { 0: h.level, 1: keyText(duty.name), 2: names.get(h.dutyTarget)! })
									: text('Lv {0} · {1}', { 0: h.level, 1: keyText(duty.name) }),
						},
						{
							text: need
								? text('Experience {exp} / {need} · Talent {n}', { exp: h.exp, need, n: h.talent })
								: text('Highest level · Talent {n}', { n: h.talent }),
							tone: 'muted',
						},
						{
							text: text(''),
							parts: [...attributes.values()].map((a) => {
								const bonus = (attrs[a.id] ?? 0) - (h.attrs[a.id] ?? 0);
								return {
									text: text('{0} {1}{2}{3}', {
										0: keyText(a.name),
										1: h.attrs[a.id] ?? 0,
										2: bonus ? ` +${Math.round(bonus)}` : '',
										3: h.talents?.[a.id] ? ` ▲${h.talents[a.id]}` : '',
									}),
								};
							}),
						},
						...(h.freePoints ? [{ text: text('{n} free points', { n: h.freePoints }), tone: 'info' as const }] : []),
					];
					for (const more of cardLines) lines.push(...(await more(api, h)));
					cards.push({
						id: h.id,
						icon: h.gender === 'f' ? '👸' : '🧔',
						title: keyText(nameKey(h)),
						lines,
						detail: { label: text('Manage'), form: { placement: 'hero', context: { hero: h.id } } },
					});
				}
				// The limit counts every hero, wherever attached; at the limit no more can be recruited.
				const cap = await stats.breakdown(api, 'heroes.cap', `player:${api.playerId}`);
				const limit = cap.value;
				return {
					header: {
						title: text('Heroes of {name}', { name: settlements.nameText(s) }),
						lines: [
							{
								text: text('{0} here · heroes {1} / {2}', {
									0: here.length,
									1: all.length,
									2: limit,
								}),
								tone: all.length >= limit ? 'warn' : 'muted',
								hint: stats.describe(cap.parts, { base: cap.base }),
							},
						],
					},
					cards,
					empty: all.length
						? text('No heroes are attached to this settlement.')
						: text('No heroes yet. Recruit them at a tavern, academy or music house.'),
				};
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
		ui.block({ page: 'heroes', column: 'left', widget: 'ui.cards', props: { view: 'heroes.cards' } });
		ui.block({ page: 'heroes', column: 'right', widget: 'ui.cards', props: { view: 'heroes.candidate-cards' } });
		ui.block({ page: 'heroes', column: 'right', widget: 'ui.rows', order: 10, props: { view: 'heroes.defense-rows' } });
		ui.entry({
			kind: 'building',
			widget: 'ui.cards',
			types: () => [...venues.values()].map((v) => v.building),
			props: { view: 'heroes.candidate-cards' },
		});
	},
});
