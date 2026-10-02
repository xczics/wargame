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
import { amounts } from '../../shared/format';
import type { CardsData, RowsData, UiCard, UiLine } from '../../shared/ui';
import type { Cost } from '../resources';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { mapUiTexts } from '../../shared/i18n';

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
	/** More lines on a hero's card (`heroes.cards`), e.g. what it gives in each role, its adventure numbers. Must only read. */
	addCardLines(lines: (api: EngineApi, hero: Hero) => Promise<UiLine[]>): void;
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
				if (!d) throw new GameError('bad_payload', `Unknown duty "${id}"`, 400, 'heroes');
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
				if (!hero) throw new GameError('not_found', 'No such hero', 404, 'heroes');
				const duty = service.duty(dutyId);
				if (dutyId !== 'idle' && !duty.anywhere && target !== hero.home)
					throw new GameError('blocked', 'A hero serves only in the settlement it is attached to', 400, 'heroes');
				const reason = dutyId === 'idle' ? null : await duty.check?.(api, hero, target);
				if (reason) throw new GameError('blocked', reason, 400, 'heroes');
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
				if (!hero || !s || s.ownerId !== hero.playerId) throw new GameError('not_found', 'No such hero or settlement', 404, 'heroes');
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
			addCardLines(l) {
				// Lines on another plugin's view: i18n keys of the plugin adding them.
				const own = ctx.services.get('i18n').scope();
				cardLines.push(async (api, hero) => mapUiTexts(await l(api, hero), own));
			},
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
				if (!hero) throw new GameError('not_found', 'No such hero', 404, 'heroes');
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
				if (!hero) throw new GameError('not_found', 'No such hero', 404, 'heroes');
				const spent = Object.values(hero.alloc).reduce((a, b) => a + b, 0);
				if (!spent) throw new GameError('blocked', 'No points to take back', 400, 'heroes');
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

		// The candidates as generic cards: a section per venue (when it renews), a card per slot; on a
		// venue's building entry only its own ("building:<type>").
		ctx.views.add({
			id: 'heroes.candidate-cards',
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
						label: { text: v.name },
						lines: [{ text: { text: 'New candidates in' }, tone: 'muted', endsAt: o.refreshesAt }],
					});
					const where = ['page:heroes', `building:${v.building}`];
					const list = [
						...o.candidates.map((c, slot) => ({ c, slot, gift: undefined as string | undefined })),
						...o.gifts.map((g) => ({ c: g.draft, slot: -1, gift: g.id })),
					];
					for (const [i, { c, slot, gift }] of list.entries()) {
						const id = `${v.id}/${gift ?? i}`;
						if (!c) {
							cards.push({ id, group: v.id, where, title: { text: o.taken.includes(i) ? 'Recruited' : 'Nobody this time' } });
							continue;
						}
						cards.push({
							id,
							group: v.id,
							where,
							icon: c.gender === 'f' ? '👸' : '🧔',
							title: { text: `${c.surname} ${c.given}` },
							lines: [
								{
									text: { text: '' },
									parts: [...attributes.values()].map((a) => ({
										text: {
											text: c.talents?.[a.id] ? '{0} {1} ▲{2}' : '{0} {1}',
											vars: { 0: a.name, 1: c.attrs[a.id] ?? 0, 2: c.talents?.[a.id] ?? 0 },
										},
									})),
								},
							],
							actions: [
								{
									command: 'heroes.recruit',
									payload: gift ? { settlement: s!.id, venue: v.id, gift } : { settlement: s!.id, venue: v.id, slot },
									label: gift ? { text: 'Recruit · free' } : { text: 'Recruit · {0}', vars: { 0: amounts(cost, icons) } },
									...(gift || affordable ? {} : { blocked: { text: 'Not enough resources' } }),
								},
							],
						});
					}
				}
				return { groups, cards, empty: { text: 'No recruiting buildings here.' } };
			},
		});

		ctx.commands.add<{ settlement: string; venue: string; slot: number; gift?: string }>({
			type: 'heroes.recruit',
			description:
				'Recruit a candidate. Payload: { "settlement", "venue", "slot" } or, for one the GM placed, { "settlement", "venue", "gift" }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string' || typeof p.venue !== 'string')
					throw new GameError('bad_payload', 'settlement and venue are required', 400, 'heroes');
				if (typeof p.gift === 'string' && p.gift) return { settlement: p.settlement, venue: p.venue, slot: -1, gift: p.gift };
				const slot = Number(p.slot);
				if (!Number.isInteger(slot) || slot < 0) throw new GameError('bad_payload', 'slot must be a whole number', 400, 'heroes');
				return { settlement: p.settlement, venue: p.venue, slot };
			},
			async execute(api, { settlement, venue: venueId, slot, gift }) {
				const s = await settlements.requireOwned(api, settlement);
				const venue = venues.get(venueId);
				if (!venue) throw new GameError('bad_payload', 'Unknown venue', 400, 'heroes');
				const o = await offer(api, s.id, venue);
				if (!o) throw new GameError('blocked', `Requires ${buildings.get(venue.building).name}`, 400, 'heroes');
				const draft = gift ? o.gifts.find((g) => g.id === gift)?.draft : o.candidates[slot];
				if (!draft) throw new GameError('gone', 'That candidate is no longer available', 400, 'heroes');
				const mine = await loadMine(api, api.playerId);
				if (mine.length >= (await stats.get(api, 'heroes.cap', `player:${api.playerId}`)))
					throw new GameError('blocked', 'Hero limit reached', 400, 'heroes');
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
							if (await buildings.level(api, s.id, v.building))
								options.push({ value: `${s.id}|${v.id}`, label: `heroes.${s.name} · ${v.name}` });
					// One box per attribute (content defines them after this form is declared).
					const fields = [...attributes.values()].map((a) => ({
						name: `attrs.${a.id}`,
						label: `heroes.${a.name} (empty = random)`,
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
					throw new GameError('bad_payload', 'settlement and venue are required', 400, 'heroes');
				const nested = { ...((p.attrs ?? {}) as Record<string, unknown>) };
				for (const [k, v] of Object.entries(p)) if (k.startsWith('attrs.')) nested[k.slice(6)] = v;
				const attrs: Record<string, number> = {};
				for (const [a, v] of Object.entries(nested)) {
					if (v === '' || v === undefined || v === null) continue;
					if (!attributes.has(a)) throw new GameError('bad_payload', `Unknown attribute "${a}"`, 400, 'heroes');
					attrs[a] = Math.round(numberInRange(0, 1e6)(v));
				}
				return { settlement, venue, attrs };
			},
			async execute(api, { settlement, venue: venueId, attrs }) {
				const s = await settlements.requireOwned(api, settlement);
				const venue = venues.get(venueId);
				if (!venue) throw new GameError('bad_payload', 'Unknown venue', 400, 'heroes');
				if (!(await buildings.level(api, s.id, venue.building)))
					throw new GameError('blocked', `Requires ${buildings.get(venue.building).name}`, 400, 'heroes');
				// Rare venues often roll nobody: try until someone turns up.
				let draft: HeroDraft | null = null;
				for (let i = 0; i < 1000 && !draft; i++) draft = venue.draft(api, seededRandom(`gift:${crypto.randomUUID()}`), 0);
				if (!draft) throw new GameError('blocked', 'Could not roll a candidate here', 400, 'heroes');
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
			if (!hero) throw new GameError('not_found', 'No such hero', 404, 'heroes');
			return hero;
		};

		ctx.commands.add<{ hero: string; duty: string; target: string | null }>({
			type: 'heroes.assign',
			description: 'Put a hero on a duty ("idle" to free it). Payload: { "hero", "duty", "target": "<settlement>" }',
			// On the hero's card: duties are held where it is attached.
			form: {
				title: 'Duty',
				placement: 'hero',
				fields: [
					{ name: 'hero', label: 'Hero', type: 'hidden' },
					{ name: 'target', label: 'At', type: 'hidden' },
					{ name: 'duty', label: 'Duty', type: 'select', required: true },
				],
				submitLabel: 'Assign',
				async prepare(api, params) {
					const hero = (await loadMine(api, api.playerId)).find((h) => h.id === params.hero);
					if (!hero || !service.duty(hero.duty).manual) return false;
					return {
						defaults: { hero: hero.id, target: hero.home, duty: hero.duty },
						options: { duty: [...duties.values()].filter((d) => d.manual).map((d) => ({ value: d.id, label: d.name })) },
					};
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.hero !== 'string' || typeof p.duty !== 'string')
					throw new GameError('bad_payload', 'hero and duty are required', 400, 'heroes');
				return { hero: p.hero, duty: p.duty, target: typeof p.target === 'string' && p.target ? p.target : null };
			},
			async execute(api, { hero: heroId, duty, target }) {
				const hero = await owned(api, heroId);
				if (!service.duty(duty).manual) throw new GameError('blocked', 'That duty is not chosen this way', 400, 'heroes');
				if (!service.duty(hero.duty).manual) throw new GameError('blocked', 'The hero is busy', 400, 'heroes');
				if (target) await settlements.requireOwned(api, target);
				await service.assign(api, hero.id, duty, duty === 'idle' ? null : target);
			},
		});

		ctx.commands.add<{ hero: string; settlement: string }>({
			type: 'heroes.setHome',
			description: 'Attach a hero to another of your settlements. Payload: { "hero", "settlement" }',
			form: {
				title: 'Attached to',
				placement: 'hero',
				fields: [
					{ name: 'hero', label: 'Hero', type: 'hidden' },
					{ name: 'settlement', label: 'Settlement', type: 'select', required: true },
				],
				submitLabel: 'Move',
				async prepare(api, params) {
					const hero = (await loadMine(api, api.playerId)).find((h) => h.id === params.hero);
					if (!hero || !service.duty(hero.duty).manual) return false;
					const post = service.duty(hero.duty);
					return {
						defaults: { hero: hero.id, settlement: hero.home },
						options: { settlement: (await settlements.mine(api, api.playerId)).map((x) => ({ value: x.id, label: x.name })) },
						...(hero.duty !== 'idle' && !post.anywhere ? { description: `Moving ends the post of ${post.name}.` } : {}),
					};
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.hero !== 'string' || typeof p.settlement !== 'string')
					throw new GameError('bad_payload', 'hero and settlement are required', 400, 'heroes');
				return { hero: p.hero, settlement: p.settlement };
			},
			async execute(api, { hero: heroId, settlement }) {
				// Away on a duty only another plugin ends (leading an army, adventuring, injured...): it stays put.
				if (!service.duty((await owned(api, heroId)).duty).manual) throw new GameError('blocked', 'The hero is busy', 400, 'heroes');
				await settlements.requireOwned(api, settlement);
				await service.setHome(api, heroId, settlement);
			},
		});

		ctx.commands.add<{ hero: string }>({
			type: 'heroes.dismiss',
			description: 'Let an idle hero go. Payload: { "hero" }',
			form: {
				title: 'Dismiss',
				placement: 'hero',
				fields: [{ name: 'hero', label: 'Hero', type: 'hidden' }],
				submitLabel: 'Dismiss',
				confirm: 'Let this hero go?',
				async prepare(api, params) {
					const hero = (await loadMine(api, api.playerId)).find((h) => h.id === params.hero);
					return hero?.duty === 'idle' ? { defaults: { hero: hero.id } } : false;
				},
			},
			parse(raw) {
				const hero = (raw as { hero?: unknown } | null)?.hero;
				if (typeof hero !== 'string') throw new GameError('bad_payload', 'hero is required', 400, 'heroes');
				return { hero };
			},
			async execute(api, { hero: heroId }) {
				const hero = await owned(api, heroId);
				if (hero.duty !== 'idle') throw new GameError('blocked', 'Only idle heroes can be dismissed', 400, 'heroes');
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
				title: 'Spend points',
				placement: 'hero',
				fields: [
					{ name: 'hero', label: 'Hero', type: 'hidden' },
					{ name: 'free', label: 'Free points', type: 'hidden' },
				],
				submitLabel: 'Spend points',
				async prepare(api, params) {
					const hero = (await loadMine(api, api.playerId)).find((h) => h.id === params.hero);
					if (!hero?.freePoints) return false;
					const fields = [...attributes.values()].map((a) => ({ name: `points.${a.id}`, label: a.name, type: 'number' as const, min: 0 }));
					return {
						fields,
						defaults: { hero: hero.id, free: hero.freePoints },
						budgets: [{ label: 'Free points', use: fields.map((f) => f.name), capacity: { free: 1 } }],
					};
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				// `points.<attribute>` fields (its form) or a `points` object.
				const flat = Object.entries(p).flatMap(([k, v]) => (k.startsWith('points.') ? [[k.slice(7), v]] : []));
				const given = flat.length ? Object.fromEntries(flat) : p.points;
				if (typeof p.hero !== 'string' || typeof given !== 'object' || given === null)
					throw new GameError('bad_payload', 'hero and points are required', 400, 'heroes');
				const points: Record<string, number> = {};
				for (const [a, n] of Object.entries(given as Record<string, unknown>)) {
					if (!attributes.has(a)) throw new GameError('bad_payload', `Unknown attribute "${a}"`, 400, 'heroes');
					if (!Number.isInteger(n) || (n as number) < 0) throw new GameError('bad_payload', 'Points must be whole numbers', 400, 'heroes');
					if (n) points[a] = n as number;
				}
				if (!Object.keys(points).length) throw new GameError('bad_payload', 'No points given', 400, 'heroes');
				return { hero: p.hero, points };
			},
			async execute(api, { hero: heroId, points }) {
				const hero = await owned(api, heroId);
				const total = Object.values(points).reduce((a, b) => a + b, 0);
				if (total > hero.freePoints) throw new GameError('blocked', `Only ${hero.freePoints} free points`, 400, 'heroes');
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
				if (typeof p.hero !== 'string') throw new GameError('bad_payload', 'hero is required', 400, 'heroes');
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
					throw new GameError('bad_payload', 'settlement and heroes (a list of ids) are required', 400, 'heroes');
				return { settlement: p.settlement, heroes: [...new Set(p.heroes as string[])] };
			},
			async execute(api, { settlement, heroes: ids }) {
				await settlements.requireOwned(api, settlement);
				const mine = await loadMine(api, api.playerId);
				for (const id of ids)
					if (mine.find((h) => h.id === id)?.home !== settlement)
						throw new GameError('bad_payload', 'Only heroes attached to this settlement can defend it', 400, 'heroes');
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
				const edge = { text: '—' };
				return {
					title: { text: 'Defence order' },
					sections: [
						{
							rows: [
								...order.map((id, i) => ({
									id,
									title: { text: '{n}. {hero}', vars: { n: i + 1, hero: `${byId.get(id)!.surname} ${byId.get(id)!.given}` } },
									actions: [
										{ ...swapped(i, i - 1), label: { text: '↑' }, ...(i === 0 ? { blocked: edge } : {}) },
										{ ...swapped(i, i + 1), label: { text: '↓' }, ...(i === order.length - 1 ? { blocked: edge } : {}) },
									],
								})),
								...(saved
									? [
											{
												id: 'reset',
												title: { text: 'Strongest first' },
												actions: [
													{ command: 'heroes.setDefenseOrder', payload: { settlement: s.id, heroes: [] }, label: { text: 'Reset' } },
												],
											},
										]
									: []),
							],
							lines: attached.length
								? saved
									? []
									: [{ text: { text: 'Strongest first (not set).' }, tone: 'muted' as const }]
								: [{ text: { text: 'No heroes attached here.' }, tone: 'muted' as const }],
						},
					],
					notes: [
						{ text: { text: 'The first heroes here that are in town defend this settlement; the rest are substitutes.' }, tone: 'muted' },
					],
				};
			},
		});

		// The Heroes page's list (generic `ui.cards`): the heroes attached to the selected settlement, each
		// with its level, duty, experience, attributes and what other plugins add; "Manage" opens its forms
		// (placement "hero": duty, attachment, free points, dismissal).
		ctx.views.add({
			id: 'heroes.cards',
			async compute(api, params): Promise<CardsData | null> {
				const s = await settlements.resolve(api, params);
				if (!s) return null;
				const all = await loadMine(api, api.playerId);
				const here = all.filter((h) => h.home === s.id);
				const names = new Map((await settlements.mine(api, api.playerId)).map((x) => [x.id, x.name]));
				const cards: UiCard[] = [];
				for (const h of here) {
					const attrs = await service.attributesOf(api, h);
					const need = service.expToNext(api, h.level);
					const duty = service.duty(h.duty);
					const lines: UiLine[] = [
						{
							text:
								h.dutyTarget && names.has(h.dutyTarget)
									? { text: 'Lv {0} · {1} · {2}', vars: { 0: h.level, 1: duty.name, 2: names.get(h.dutyTarget)! } }
									: { text: 'Lv {0} · {1}', vars: { 0: h.level, 1: duty.name } },
						},
						{
							text: need
								? { text: 'Experience {exp} / {need} · Talent {n}', vars: { exp: h.exp, need, n: h.talent } }
								: { text: 'Highest level · Talent {n}', vars: { n: h.talent } },
							tone: 'muted',
						},
						{
							text: { text: '' },
							parts: [...attributes.values()].map((a) => {
								const bonus = (attrs[a.id] ?? 0) - (h.attrs[a.id] ?? 0);
								return {
									text: {
										text: '{0} {1}{2}{3}',
										vars: {
											0: a.name,
											1: h.attrs[a.id] ?? 0,
											2: bonus ? ` +${Math.round(bonus)}` : '',
											3: h.talents?.[a.id] ? ` ▲${h.talents[a.id]}` : '',
										},
									},
								};
							}),
						},
						...(h.freePoints ? [{ text: { text: '{n} free points', vars: { n: h.freePoints } }, tone: 'info' as const }] : []),
					];
					for (const more of cardLines) lines.push(...(await more(api, h)));
					cards.push({
						id: h.id,
						icon: h.gender === 'f' ? '👸' : '🧔',
						title: { text: `${h.surname} ${h.given}` },
						lines,
						detail: { label: { text: 'Manage' }, form: { placement: 'hero', context: { hero: h.id } } },
					});
				}
				return {
					header: {
						title: { text: 'Heroes of {name}', vars: { name: s.name } },
						lines: [{ text: { text: `(${here.length} / ${all.length})` }, tone: 'muted' }],
					},
					cards,
					empty: all.length
						? { text: 'No heroes are attached to this settlement.' }
						: { text: 'No heroes yet. Recruit them at a tavern, academy or music house.' },
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
