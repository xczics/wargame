/**
 * Settlements: every place on the map that holds buildings, resources or (later) troops.
 *
 * What a settlement IS comes from registered kinds (`defineKind`): the default content
 * registers capital / city / resource fortress / military fortress; NPC plugins register
 * their own (fortresses to raid for troops, outposts to raid for food...) the same way.
 *
 * Layouts:
 *   - "ring": an inner city on the centre tile plus outer cities on surrounding tiles.
 *     Outer cities 1-8 go on the first ring (a full 3x3), further ones (items only) on the
 *     second ring (up to 5x5 = 24 outer cities). Each must touch an existing district.
 *   - "single": one district on one tile (fortresses).
 *
 * Every district has building slots: fixed for inner/core districts, rolled at random for
 * outer ones. Which building categories a district accepts is declared by the kind.
 * All districts of a settlement share its resource pool (holder `settlement:<id>`).
 */
import {
	csvRules,
	definePlugin,
	type EngineApi,
	executeCommand,
	fields,
	type FormPatch,
	gameErrors,
	numberInRange,
	PluginError,
	type ReadApi,
	shape,
	type ViewParams,
} from '../../kernel';
import { requestContext } from '../../runtime/context';
import type { MapTile, NearbyOverview, SettlementDetail, SettlementSummary } from '../../shared/api';
import { amounts } from '../../shared/format';
import type { CellsData, GridCell, GridSide, UiCellItem, UiText } from '../../shared/ui';
import type { Cost } from '../resources';
import type { Tile } from '../world-map';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, literal, uiTexts } from '../../shared/i18n';

const fail = gameErrors('settlements');
const text = uiTexts('settlements');

/** Design numbers (./data/rules.csv); GM overrides go on top. */
const RULES = csvRules(rulesCsv);

export interface DistrictTemplate {
	/** e.g. "inner", "outer", "core". */
	type: string;
	/** Building categories allowed in this district. */
	accepts: string[];
	/** Number of slots, or [min, max] rolled at random when the district is created. */
	slots(api: ReadApi): number | [number, number];
}

export interface SettlementKind {
	id: string;
	name: string;
	/** Shown on the map. */
	icon?: string;
	/** NPC settlements have no owner and cannot be founded by players. */
	npc?: boolean;
	/** Can troops be stationed here (used by the future army system). */
	garrison: boolean;
	layout: 'ring' | 'single';
	centre: DistrictTemplate;
	/**
	 * Ring layout only. `initial` outer cities are created when the settlement is founded (>= 1);
	 * `cost` is what the first extra one costs (the n-th extra one costs n times this).
	 */
	outer?: DistrictTemplate & { initial: number; cost?: (api: ReadApi) => Cost };
	/** Max settlements of this kind per player (becomes stat `settlements.limit.<id>`). Omit for unlimited. */
	limit?: (api: ReadApi) => number;
	/** Hard limit on the above, whatever the bonuses. */
	limitMax?: (api: ReadApi) => number;
	/** Resources paid from the founding settlement. */
	foundCost?: (api: ReadApi) => Cost;
	/** Free-form data for other plugins (e.g. NPC loot tables, combat hooks). */
	extra?: Record<string, unknown>;
}

export interface Settlement {
	id: string;
	kind: string;
	ownerId: string | null;
	name: string;
	x: number;
	y: number;
	createdAt: number;
	districts: District[];
}

export interface District {
	id: string;
	settlementId: string;
	type: string;
	idx: number;
	slots: number;
	x: number;
	y: number;
}

/** Adds data to the `settlements.detail` view (e.g. buildings fill in slots). */
export type DetailExtender = (api: EngineApi, settlement: Settlement, detail: SettlementDetail) => Promise<void>;

export interface SettlementsService {
	defineKind(kind: SettlementKind): void;
	kind(id: string): SettlementKind;
	kinds(): readonly SettlementKind[];
	entity(id: string): string;
	get(api: ReadApi, id: string): Promise<Settlement | null>;
	/** The settlement if the acting player owns it; otherwise throws 404. */
	requireOwned(api: ReadApi, id: string): Promise<Settlement>;
	/** A settlement's name as a text: its kind's name until renamed (a key), else the player's words as typed. */
	nameText(settlement: { name: string }): UiText;
	mine(api: ReadApi, ownerId: string): Promise<Settlement[]>;
	capital(api: ReadApi, ownerId: string): Promise<Settlement | null>;
	/** Resolve `?settlement=` (default: capital) to a settlement the acting player owns. */
	resolve(api: ReadApi, params: ViewParams): Promise<Settlement | null>;
	district(settlement: Settlement, districtId: string): { district: District; template: DistrictTemplate };
	/**
	 * Why `ownerId` cannot found a settlement of `kind` at `tile` right now (a kind players may
	 * found, their limit, free land around it), or null. Must only read.
	 */
	foundable(api: ReadApi, ownerId: string, kind: string, tile: Tile): Promise<UiText | null>;
	/** How many of `kind` the player has and may have (bonuses included, hard limit applied); null for unlimited kinds. */
	limitOf(api: ReadApi, ownerId: string, kind: string): Promise<{ have: number; limit: number; max: number } | null>;
	/** Create a settlement (claims tiles, creates districts and its resource pool). Returns its id. */
	found(api: EngineApi, input: { kind: string; ownerId: string | null; name: string; centre: Tile }): Promise<string>;
	/** Free tiles where the next outer city may go. */
	outerCandidates(api: ReadApi, settlement: Settlement): Promise<Tile[]>;
	/** Every tile around the settlement an outer city may ever stand on (taken or not, not its own); none for other layouts. */
	outerArea(settlement: Settlement): Tile[];
	/** Add an outer city. `ignoreTechLimit` (items) still respects the hard limit. */
	addOuter(api: EngineApi, settlementId: string, tile: Tile, options?: { ignoreTechLimit?: boolean }): Promise<void>;
	addDetailExtender(extender: DetailExtender): void;
	/** What the `settlements.detail` view returns (extenders included), for other plugins' views of the same settlement. */
	detail(api: EngineApi, params: ViewParams): Promise<SettlementDetail | null>;
	/** Add building slots to a district (e.g. an item raising an outer city's slots). */
	addSlots(api: EngineApi, settlementId: string, districtId: string, n: number): Promise<void>;
	/** Let a district type of a kind accept one more building category (e.g. a plugin's new "arena"). */
	allowCategory(kindId: string, districtType: string, category: string): void;
	/** Called inside `found`, once the new settlement exists (e.g. to give it starting buildings). */
	onFounded(listener: (api: EngineApi, settlement: Settlement) => Promise<void>): void;
	/**
	 * Take a settlement off the map (e.g. an NPC camp cleared away): its districts, its tiles and the settlement.
	 * Lock it (`api.lock(entity(id))`) before reading it. Listeners drop their own data about it first.
	 */
	remove(api: EngineApi, id: string): Promise<void>;
	onRemoved(listener: (api: EngineApi, settlement: Settlement) => Promise<void>): void;
}

declare module '../../kernel' {
	interface ServiceMap {
		settlements: SettlementsService;
	}
}

/** Outer cities that fit on the first ring (a full 3x3 including the centre). */
const RING1 = 8;
/** Outer cities that fit within two rings (5x5 minus the centre). */
const RING2 = 24;
const NAME_MAX = 30;
/** Most settlements the `settlements.nearby` overview lists. */
const NEARBY_LIST = 100;
/** Hard limit on the overview radius the GM may set (the query reads a square this size). */
const NEARBY_HARD_MAX = 200;

function randomInt(min: number, max: number) {
	return min + (crypto.getRandomValues(new Uint32Array(1))[0] % (max - min + 1));
}

interface SettlementRow {
	id: string;
	kind: string;
	owner_id: string | null;
	name: string;
	x: number;
	y: number;
	created_at: number;
}

export default definePlugin({
	id: 'settlements',
	version: '0.1.0',
	description: 'Capitals, cities, fortresses and NPC settlements on the world map',
	dependsOn: ['accounts', 'world-map', 'stats', 'resources', 'timeline', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const accounts = ctx.services.get('accounts');
		const map = ctx.services.get('worldMap');
		const stats = ctx.services.get('stats');
		const resources = ctx.services.get('resources');
		const timeline = ctx.services.get('timeline');
		const kinds = new Map<string, SettlementKind>();
		const extenders: DetailExtender[] = [];
		const foundedListeners: ((api: EngineApi, settlement: Settlement) => Promise<void>)[] = [];
		const removedListeners: ((api: EngineApi, settlement: Settlement) => Promise<void>)[] = [];
		const removedIn = (api: ReadApi) => api.memo('settlements:removed', async () => new Set<string>());

		const outerTech = ctx.config.define('outerTechLimit', {
			description: 'Outer cities per capital/city before research bonuses. Research may raise it (up to 8 without items).',
			default: () => RULES.outerTechLimit as number,
			parse: numberInRange(1, RING1),
		});
		const nearbyRadius = ctx.config.define('nearbyRadius', {
			description: `Largest radius (tiles) of the map overview listing settlements around the map's centre (at most ${NEARBY_HARD_MAX}).`,
			default: () => RULES.nearbyRadius as number,
			parse: (raw) => Math.floor(numberInRange(1, NEARBY_HARD_MAX)(raw)),
		});
		const outerHard = ctx.config.define('outerHardLimit', {
			description: 'Absolute outer-city cap reachable with items (at most 24 = two rings).',
			default: () => RING2,
			parse: numberInRange(1, RING2),
		});
		stats.define({
			id: 'settlements.outer.tech',
			description: 'outer-city limit',
			base: (api) => outerTech.get(api),
			integer: true,
			// Research alone fills at most the first ring (a 3x3); beyond that takes items.
			max: RING1,
		});
		stats.define({
			id: 'settlements.outer.hard',
			description: 'Outer-city limit with items',
			base: (api) => outerHard.get(api),
			integer: true,
			max: RING2,
		});

		const entity = (id: string) => `settlement:${id}`;
		const toSettlement = (r: SettlementRow, districts: District[]): Settlement => ({
			id: r.id,
			kind: r.kind,
			ownerId: r.owner_id,
			name: r.name,
			x: r.x,
			y: r.y,
			createdAt: r.created_at,
			districts,
		});

		async function loadDistricts(api: ReadApi, ids: string[]): Promise<Map<string, District[]>> {
			const out = new Map<string, District[]>(ids.map((id) => [id, []]));
			for (let i = 0; i < ids.length; i += 100) {
				const chunk = ids.slice(i, i + 100);
				const { results } = await api.db
					.prepare(
						`SELECT id, settlement_id, type, idx, slots, x, y FROM settlements_districts WHERE settlement_id IN (${chunk.map(() => '?').join(',')}) ORDER BY idx`,
					)
					.bind(...chunk)
					.all<{ id: string; settlement_id: string; type: string; idx: number; slots: number; x: number; y: number }>();
				for (const d of results) {
					out
						.get(d.settlement_id)!
						.push({ id: d.id, settlementId: d.settlement_id, type: d.type, idx: d.idx, slots: d.slots, x: d.x, y: d.y });
				}
			}
			return out;
		}

		function rollSlots(api: ReadApi, template: DistrictTemplate) {
			const s = template.slots(api);
			return Array.isArray(s) ? randomInt(s[0], s[1]) : s;
		}

		const service: SettlementsService = {
			defineKind(kind) {
				if (kinds.has(kind.id)) throw new PluginError(`Settlement kind "${kind.id}" defined twice`);
				kind = { ...kind, name: ctx.services.get('i18n').own(kind.name) };
				if (kind.layout === 'ring' && (!kind.outer || kind.outer.initial < 1)) {
					throw new PluginError(`Ring settlement "${kind.id}" needs an outer template with initial >= 1`);
				}
				kinds.set(kind.id, kind);
				if (kind.limit) {
					const limit = kind.limit;
					stats.define({
						id: `settlements.limit.${kind.id}`,
						description: text('Max {0} per player', { 0: keyText(kind.name) }),
						base: (api) => limit(api),
						integer: true,
						min: 0,
					});
				}
			},
			kind(id) {
				const k = kinds.get(id);
				if (!k) throw new PluginError(`Unknown settlement kind "${id}" (plugin disabled?)`);
				return k;
			},
			kinds: () => [...kinds.values()],
			entity,

			async get(api, id) {
				// Removed earlier in this call (the rows go only at commit).
				if ((await removedIn(api)).has(id)) return null;
				return api.memo(`settlements:get:${id}`, async () => {
					const row = await api.db.prepare('SELECT * FROM settlements_settlements WHERE id = ?').bind(id).first<SettlementRow>();
					if (!row) return null;
					return toSettlement(row, (await loadDistricts(api, [id])).get(id)!);
				});
			},
			nameText: (x) => (ctx.services.get('i18n').isKey(x.name) ? keyText(x.name) : literal(x.name)),
			async requireOwned(api, id) {
				const s = await service.get(api, id);
				if (!s || s.ownerId !== api.playerId) throw fail('not_found', 'No such settlement', 404);
				return s;
			},
			mine(api, ownerId) {
				return api.memo(`settlements:mine:${ownerId}`, async () => {
					const { results } = await api.db
						.prepare('SELECT * FROM settlements_settlements WHERE owner_id = ? ORDER BY created_at')
						.bind(ownerId)
						.all<SettlementRow>();
					const districts = await loadDistricts(
						api,
						results.map((r) => r.id),
					);
					// Share objects with `get` so changes made during a command are seen everywhere.
					return Promise.all(results.map((r) => api.memo(`settlements:get:${r.id}`, async () => toSettlement(r, districts.get(r.id)!))));
				});
			},
			async capital(api, ownerId) {
				return (await service.mine(api, ownerId)).find((s) => s.kind === 'capital') ?? null;
			},
			async resolve(api, params) {
				if (params.settlement) return service.requireOwned(api, params.settlement);
				return service.capital(api, api.playerId);
			},
			district(settlement, districtId) {
				const district = settlement.districts.find((d) => d.id === districtId);
				if (!district) throw fail('not_found', 'No such district', 404);
				const kind = service.kind(settlement.kind);
				const template = district.type === kind.outer?.type ? kind.outer : kind.centre;
				return { district, template };
			},

			async foundable(api, ownerId, kindId, tile) {
				const kind = kinds.get(kindId);
				if (!kind || kind.npc || kindId === 'capital') return text('That kind of settlement cannot be founded');
				const lim = await service.limitOf(api, ownerId, kindId);
				if (lim && lim.have >= lim.limit) return text('You cannot have more of: {0}', { 0: keyText(kind.name) });
				const c = { x: map.wrap(tile.x), y: map.wrap(tile.y) };
				if ((await map.occupants(api, [c])).size) return text('That tile is already occupied');
				if (kind.layout === 'ring') {
					const ring = map.square(c, 1).filter((t) => t.x !== c.x || t.y !== c.y);
					if (ring.length - (await map.occupants(api, ring)).size < kind.outer!.initial)
						return text('Not enough free land around that tile');
				}
				return null;
			},

			async limitOf(api, ownerId, kindId) {
				const kind = service.kind(kindId);
				if (!kind.limit) return null;
				const have = (await service.mine(api, ownerId)).filter((s) => s.kind === kindId).length;
				const max = kind.limitMax ? kind.limitMax(api) : Infinity;
				return { have, limit: Math.min(max, await stats.get(api, `settlements.limit.${kindId}`, `player:${ownerId}`)), max };
			},

			async found(api, { kind: kindId, ownerId, name, centre }) {
				const kind = service.kind(kindId);
				const id = crypto.randomUUID();
				const c = { x: map.wrap(centre.x), y: map.wrap(centre.y) };
				const tiles: Tile[] = [c];
				if (kind.layout === 'ring') {
					const ring = map.square(c, 1).filter((t) => t.x !== c.x || t.y !== c.y);
					const taken = await map.occupants(api, ring);
					const free = ring.filter((t) => !taken.has(`${t.x},${t.y}`));
					if (free.length < kind.outer!.initial) throw fail('no_room', 'Not enough free land around that tile', 409);
					tiles.push(...free.slice(0, kind.outer!.initial));
				}
				await map.claim(api, tiles, entity(id));

				const districts: District[] = tiles.map((t, idx) => {
					const template = idx === 0 ? kind.centre : kind.outer!;
					return { id: crypto.randomUUID(), settlementId: id, type: template.type, idx, slots: rollSlots(api, template), x: t.x, y: t.y };
				});
				api.write(
					api.db
						.prepare('INSERT INTO settlements_settlements (id, kind, owner_id, name, x, y, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
						.bind(id, kindId, ownerId, name, c.x, c.y, api.now),
					...districts.map((d) =>
						api.db
							.prepare('INSERT INTO settlements_districts (id, settlement_id, type, idx, slots, x, y) VALUES (?, ?, ?, ?, ?, ?, ?)')
							.bind(d.id, id, d.type, d.idx, d.slots, d.x, d.y),
					),
				);
				const settlement: Settlement = { id, kind: kindId, ownerId, name, x: c.x, y: c.y, createdAt: api.now, districts };
				await api.memo(`settlements:get:${id}`, async () => settlement);
				if (ownerId) (await service.mine(api, ownerId)).push(settlement);
				await resources.settle(api, entity(id)); // creates the pool with the starting resources
				for (const listener of foundedListeners) await listener(api, settlement);
				return id;
			},

			async outerCandidates(api, settlement) {
				const kind = service.kind(settlement.kind);
				if (kind.layout !== 'ring') return [];
				const outer = settlement.districts.filter((d) => d.type === kind.outer!.type).length;
				if (outer >= RING2) return [];
				const centre = { x: settlement.x, y: settlement.y };
				const ring = outer < RING1 ? 1 : 2;
				const mine = new Set(settlement.districts.map((d) => `${d.x},${d.y}`));
				const candidates = map
					.square(centre, ring)
					.filter((t) => map.ring(centre, t) === ring && !mine.has(`${t.x},${t.y}`))
					.filter((t) => settlement.districts.some((d) => map.ring(d, t) === 1));
				const taken = await map.occupants(api, candidates);
				return candidates.filter((t) => !taken.has(`${t.x},${t.y}`));
			},

			outerArea(settlement) {
				if (service.kind(settlement.kind).layout !== 'ring') return [];
				const mine = new Set(settlement.districts.map((d) => `${d.x},${d.y}`));
				return map.square({ x: settlement.x, y: settlement.y }, 2).filter((t) => !mine.has(`${t.x},${t.y}`));
			},

			async addOuter(api, settlementId, tile, { ignoreTechLimit = false } = {}) {
				const s = await service.get(api, settlementId);
				if (!s) throw fail('not_found', 'No such settlement', 404);
				const kind = service.kind(s.kind);
				if (kind.layout !== 'ring') throw fail('no_outer', text('{0} has no outer cities', { 0: keyText(kind.name) }));
				const outer = s.districts.filter((d) => d.type === kind.outer!.type).length;
				const hard = await stats.get(api, 'settlements.outer.hard', entity(s.id));
				const tech = Math.min(hard, await stats.get(api, 'settlements.outer.tech', entity(s.id)));
				if (outer >= (ignoreTechLimit ? hard : tech)) {
					throw fail(
						'outer_limit',
						ignoreTechLimit || outer >= hard ? 'Outer city limit reached' : 'Research more to build more outer cities',
					);
				}
				const t = { x: map.wrap(tile.x), y: map.wrap(tile.y) };
				if (!(await service.outerCandidates(api, s)).some((c) => c.x === t.x && c.y === t.y)) {
					throw fail('bad_tile', 'An outer city must go on a free tile next to this settlement (inner ring first)');
				}
				await map.claim(api, [t], entity(s.id));
				const district: District = {
					id: crypto.randomUUID(),
					settlementId: s.id,
					type: kind.outer!.type,
					idx: Math.max(...s.districts.map((d) => d.idx)) + 1,
					slots: rollSlots(api, kind.outer!),
					...t,
				};
				api.write(
					api.db
						.prepare('INSERT INTO settlements_districts (id, settlement_id, type, idx, slots, x, y) VALUES (?, ?, ?, ?, ?, ?, ?)')
						.bind(district.id, s.id, district.type, district.idx, district.slots, t.x, t.y),
				);
				s.districts.push(district);
			},

			detail: (api, params) => detailOf(api, params),
			addDetailExtender: (e) => void extenders.push(e),
			onFounded: (l) => void foundedListeners.push(l),
			onRemoved: (l) => void removedListeners.push(l),
			async remove(api, id) {
				const s = await service.get(api, id);
				if (!s) return;
				for (const listener of removedListeners) await listener(api, s);
				(await removedIn(api)).add(id);
				map.release(api, entity(id));
				api.write(
					api.db.prepare('DELETE FROM settlements_districts WHERE settlement_id = ?').bind(id),
					api.db.prepare('DELETE FROM settlements_settlements WHERE id = ?').bind(id),
				);
				if (s.ownerId) {
					const mine = await service.mine(api, s.ownerId);
					const i = mine.findIndex((x) => x.id === id);
					if (i >= 0) mine.splice(i, 1);
				}
			},
			async addSlots(api, settlementId, districtId, n) {
				const s = await service.get(api, settlementId);
				if (!s) throw fail('not_found', 'No such settlement', 404);
				const { district } = service.district(s, districtId);
				district.slots += n;
				api.write(api.db.prepare('UPDATE settlements_districts SET slots = ? WHERE id = ?').bind(district.slots, district.id));
			},
			allowCategory(kindId, districtType, category) {
				const kind = service.kind(kindId);
				const template = [kind.centre, kind.outer].find((t) => t?.type === districtType);
				if (!template) throw new PluginError(`Settlement kind "${kindId}" has no "${districtType}" district`);
				if (!template.accepts.includes(category)) template.accepts.push(category);
			},
		};

		ctx.services.provide('settlements', service);
		timeline.addOwnerResolver(
			'settlement',
			async (db, id) =>
				(await db.prepare('SELECT owner_id FROM settlements_settlements WHERE id = ?').bind(id).first<{ owner_id: string | null }>())
					?.owner_id ?? null,
		);

		resources.addHolderKind('settlement');
		// Resource pools: `?settlement=` (must be owned) or the capital.
		resources.setHolderResolver(async (api, params) => {
			const s = await service.resolve(api, params);
			if (!s) throw fail('no_settlement', 'You have no settlement yet', 404);
			return entity(s.id);
		});

		// Every new account gets a capital at a random free spot.
		accounts.onAccountCreated(async ({ kernel, env, userId }) => {
			await executeCommand(kernel, env.DB, await requestContext(kernel, env, userId), 'settlements.foundCapital', null);
		});

		ctx.meta.add('settlementKinds', () => service.kinds().map((k) => ({ id: k.id, name: k.name, npc: !!k.npc, garrison: k.garrison })));

		/* ----- views ------------------------------------------------------------------- */

		const summary = (s: Settlement): SettlementSummary => ({
			id: s.id,
			kind: s.kind,
			name: s.name,
			x: s.x,
			y: s.y,
			outer: s.districts.filter((d) => d.type === service.kind(s.kind).outer?.type).length,
		});

		ctx.views.add({ id: 'settlements.mine', compute: async (api) => (await service.mine(api, api.playerId)).map(summary) });

		ctx.views.add({ id: 'settlements.detail', compute: (api, params) => service.detail(api, params) });

		// The City page's district board (generic `ui.cells`): the districts where they lie (3x3, 5x5 once
		// the second ring is used), the inner city in the middle; free tiles where an outer city may go
		// can be clicked to build one. Selecting a district shows its slots (filter "city.district").
		ctx.views.add({
			id: 'settlements.districts',
			async compute(api, params): Promise<CellsData | null> {
				const d = await service.detail(api, params);
				if (!d || (d.districts.length < 2 && !d.nextOuter)) return null;
				const icons = Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id]));
				const terrain = (x: number, y: number) => d.terrain?.[`${x},${y}`];
				const terrainName = (x: number, y: number) => {
					const name = terrain(x, y)?.name;
					return name ? keyText(name) : text('');
				};
				const terrainText = (x: number, y: number) => {
					const t = terrain(x, y);
					if (!t) return text('');
					const bonus = Object.entries(t.bonus)
						.filter(([, v]) => v)
						.map(([r, v]) => `${icons[r] ?? r}${v > 0 ? '+' : ''}${v}%`)
						.join(' ');
					return bonus ? text('{0} {1}', { 0: keyText(t.name ?? t.terrain), 1: bonus }) : keyText(t.name ?? t.terrain);
				};
				const label = (type: string, idx: number) => (type === 'inner' ? text('Inner city') : text('Outer city {0}', { 0: idx }));
				const outer = d.districts.filter((x) => x.type === 'outer').length;
				const next = d.nextOuter;
				const placed: { dx: number; dy: number; district: boolean; item: UiCellItem }[] = [
					...d.districts.map((x) => ({
						dx: map.wrap(x.x - d.x),
						dy: map.wrap(x.y - d.y),
						district: true,
						item: {
							id: x.id,
							label: x.type === 'inner' ? text('Inner') : literal(String(x.idx)),
							sub: literal(`${x.slots.filter((s) => s.current).length}/${x.slots.length}`),
							note: terrainName(x.x, x.y),
							title: text('{0} · {1}', { 0: [label(x.type, x.idx)], 1: [terrainText(x.x, x.y)] }),
							tone: x.type === 'inner' ? ('strong' as const) : ('solid' as const),
							selectable: true,
						},
					})),
					...(next?.candidates ?? []).map((c) => ({
						dx: map.wrap(c.x - d.x),
						dy: map.wrap(c.y - d.y),
						district: false,
						item: {
							id: `${c.x},${c.y}`,
							label: text('＋'),
							note: terrainName(c.x, c.y),
							title: text('{0} · {1}', { 0: [text('Build an outer city here')], 1: [terrainText(c.x, c.y)] }),
							tone: next!.blocked ? ('muted' as const) : ('add' as const),
							action: {
								command: 'settlements.addOuter',
								payload: { settlement: d.id, x: c.x, y: c.y },
								label: text('Build an outer city here'),
								...(next!.blocked ? { blocked: next!.blocked } : {}),
								confirm: text('Build an outer city at ({x}, {y})? {terrain} · cost {cost} · outer cities {n}/{limit}', {
									x: c.x,
									y: c.y,
									terrain: [terrainText(c.x, c.y)],
									cost: amounts(next!.cost, icons) || '—',
									n: outer + 1,
									limit: d.limits.outerTech,
								}),
							},
						},
					})),
				];
				const r = Math.max(1, ...placed.filter((p) => p.district).map((p) => Math.max(Math.abs(p.dx), Math.abs(p.dy))));
				// Rows from north (higher y) down, as on the map.
				const cells: (UiCellItem | null)[] = [];
				for (let row = 0; row <= 2 * r; row++)
					for (let col = 0; col <= 2 * r; col++) cells.push(placed.find((p) => p.dx === col - r && p.dy === r - row)?.item ?? null);
				return { title: text('Districts'), columns: 2 * r + 1, cells, defaultSelected: d.districts[0]?.id };
			},
		});

		const detailOf = (api: EngineApi, params: ViewParams) =>
			api.memo(`settlements:detail:${params.settlement ?? ''}`, async (): Promise<SettlementDetail | null> => {
				const s = await service.resolve(api, params);
				if (!s) return null;
				await timeline.sync(api, entity(s.id));
				const kind = service.kind(s.kind);
				const hard = await stats.get(api, 'settlements.outer.hard', entity(s.id));
				const detail: SettlementDetail = {
					...summary(s),
					kindName: kind.name,
					garrison: kind.garrison,
					districts: s.districts.map((d) => ({ id: d.id, type: d.type, idx: d.idx, x: d.x, y: d.y, slots: [] })),
					limits: {
						outerTech: Math.min(hard, await stats.get(api, 'settlements.outer.tech', entity(s.id))),
						outerHard: hard,
						queue: 0,
						queueUsed: 0,
					},
				};
				if (kind.layout === 'ring' && kind.outer) {
					const outer = s.districts.filter((d) => d.type === kind.outer!.type).length;
					const extra = outer - kind.outer.initial;
					detail.nextOuter = {
						candidates: await service.outerCandidates(api, s),
						cost: Object.fromEntries(Object.entries(kind.outer.cost?.(api) ?? {}).map(([r, n]) => [r, n * (extra + 1)])),
						...(outer >= detail.limits.outerTech
							? { blocked: text(outer >= hard ? 'Outer city limit reached' : 'Research more to build more outer cities') }
							: {}),
					};
				}
				for (const extend of extenders) await extend(api, s, detail);
				return detail;
			});
		service.detail = detailOf;

		// Map window: `?x=&y=&r=` (r <= 25), default centred on the capital.
		ctx.views.add({
			id: 'settlements.map',
			async compute(api, params): Promise<MapTile[]> {
				const capital = await service.capital(api, api.playerId);
				const x = params.x !== undefined ? Number(params.x) : (capital?.x ?? 0);
				const y = params.y !== undefined ? Number(params.y) : (capital?.y ?? 0);
				const r = Math.min(25, Math.max(0, Math.floor(Number(params.r ?? 7))));
				if (!Number.isFinite(x) || !Number.isFinite(y)) throw fail('bad_params', 'x and y must be numbers');
				const tiles = await map.window(api, { x: map.wrap(Math.floor(x)), y: map.wrap(Math.floor(y)) }, r);
				const ids = [...new Set(tiles.filter((t) => t.entity.startsWith('settlement:')).map((t) => t.entity.slice(11)))];
				const settlements = new Map<string, SettlementRow>();
				for (let i = 0; i < ids.length; i += 100) {
					const chunk = ids.slice(i, i + 100);
					const { results } = await api.db
						.prepare(`SELECT * FROM settlements_settlements WHERE id IN (${chunk.map(() => '?').join(',')})`)
						.bind(...chunk)
						.all<SettlementRow>();
					for (const s of results) settlements.set(s.id, s);
				}
				const owners = await accounts.usernames(api.db, [
					...new Set([...settlements.values()].flatMap((s) => (s.owner_id ? [s.owner_id] : []))),
				]);
				return tiles.flatMap((t) => {
					const s = settlements.get(t.entity.slice(11));
					if (!s) return [];
					return [
						{
							x: t.x,
							y: t.y,
							settlement: s.id,
							kind: s.kind,
							name: s.name,
							ownerId: s.owner_id,
							ownerName: s.owner_id ? (owners[s.owner_id] ?? null) : null,
							centre: t.x === s.x && t.y === s.y,
						},
					];
				});
			},
		});

		// Settlements on the map (generic grid): icon at the centre, border by owner, what it is when
		// selected (and a way to open one's own). Home: the selected settlement.
		map.setHome(async (api, params) => {
			const s = await service.resolve(api, params).catch(() => null);
			return s ? { x: s.x, y: s.y } : null;
		});
		map.addLayer(async (api, tiles) => {
			const out = new Map<string, Partial<GridCell>>();
			const held = [...(await map.occupants(api, tiles))].filter(([, e]) => e.startsWith('settlement:'));
			const found = new Map<string, Settlement>();
			for (const id of new Set(held.map(([, e]) => e.slice('settlement:'.length)))) {
				const s = await service.get(api, id);
				if (s) found.set(id, s);
			}
			const owners = await accounts.usernames(api.db, [...new Set([...found.values()].flatMap((s) => (s.ownerId ? [s.ownerId] : [])))]);
			for (const [key, e] of held) {
				const s = found.get(e.slice('settlement:'.length));
				if (!s) continue;
				const [x, y] = key.split(',').map(Number);
				const kind = kinds.get(s.kind);
				const mine = s.ownerId === api.playerId;
				out.set(key, {
					icon: x === s.x && y === s.y ? (kind?.icon ?? '☠️') : '·',
					tone: mine ? 'mine' : s.ownerId ? 'occupied' : 'enemy',
					title: [service.nameText(s)],
					info: [
						{
							text: text('{name} ({kind}) · {owner}', {
								name: service.nameText(s),
								kind: keyText(kind?.name ?? s.kind),
								owner: mine ? text('yours') : s.ownerId ? literal(owners[s.ownerId] ?? '?') : text('NPC'),
							}),
						},
					],
					...(mine ? { actions: [{ params: { settlement: s.id }, label: text('Open') }] } : {}),
				});
			}
			return out;
		});

		// Overview of the surroundings: `?x=&y=` (default: the selected settlement), `r` tiles
		// (straight line, at most the `nearbyRadius` rule), `npc=1` for NPC settlements only. Not the player's own.
		ctx.views.add({
			id: 'settlements.nearby',
			async compute(api, params): Promise<NearbyOverview> {
				const maxRadius = nearbyRadius.get(api);
				const here = params.x === undefined ? await service.resolve(api, params).catch(() => null) : null;
				const x = params.x !== undefined ? Number(params.x) : here?.x;
				const y = params.y !== undefined ? Number(params.y) : here?.y;
				if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return { maxRadius, settlements: [] };
				const r = Math.min(maxRadius, Math.max(1, Math.floor(Number(params.r ?? 20)) || 20));
				return nearbyOf(api, { x: map.wrap(Math.floor(x)), y: map.wrap(Math.floor(y)) }, r, params.npc === '1');
			},
		});
		// Beside the world map: the NPC settlements around its centre, nearest first (`nearbyR` tiles).
		map.addSide(async (api, centre, params): Promise<GridSide> => {
			const maxRadius = nearbyRadius.get(api);
			const radii = [...new Set([...[10, 20, 30, 50, 100, 200].filter((r) => r < maxRadius), maxRadius])];
			const r = Math.min(maxRadius, Math.max(1, Math.floor(Number(params.nearbyR ?? 20)) || 20));
			const found = await nearbyOf(api, centre, r, true);
			return {
				title: text('NPC settlements nearby'),
				choice: {
					param: 'nearbyR',
					options: radii.map((v) => ({ value: String(v), label: text('{n} tiles', { n: v }) })),
					selected: String(r),
				},
				notes: [{ text: text('Around the centre of the map ({x}, {y}).', { x: centre.x, y: centre.y }), tone: 'muted' }],
				items: found.settlements.map((s) => ({
					label: text('{0} {1} ({2})', {
						0: kinds.get(s.kind)?.icon ?? '☠️',
						1: service.nameText(s),
						2: keyText(kinds.get(s.kind)?.name ?? s.kind),
					}),
					sub: [text('({0}, {1})', { 0: s.x, 1: s.y }) as UiText, text('{n} tiles', { n: s.distance })],
					at: { x: s.x, y: s.y },
				})),
				empty: text('None.'),
			};
		});
		async function nearbyOf(api: ReadApi, centre: Tile, r: number, npcOnly: boolean): Promise<NearbyOverview> {
			{
				const maxRadius = nearbyRadius.get(api);
				const tiles = await map.window(api, centre, r);
				const ids = [...new Set(tiles.filter((t) => t.entity.startsWith('settlement:')).map((t) => t.entity.slice(11)))];
				const rows: SettlementRow[] = [];
				for (let i = 0; i < ids.length; i += 100) {
					const chunk = ids.slice(i, i + 100);
					const { results } = await api.db
						.prepare(`SELECT * FROM settlements_settlements WHERE id IN (${chunk.map(() => '?').join(',')})`)
						.bind(...chunk)
						.all<SettlementRow>();
					rows.push(...results);
				}
				const found = rows
					.filter((s) => s.owner_id !== api.playerId && (!npcOnly || !s.owner_id))
					.map((s) => ({ s, distance: map.distance(centre, { x: s.x, y: s.y }) }))
					.filter(({ distance }) => distance <= r)
					.sort((a, b) => a.distance - b.distance || a.s.y - b.s.y || a.s.x - b.s.x)
					.slice(0, NEARBY_LIST);
				const owners = await accounts.usernames(api.db, [...new Set(found.flatMap(({ s }) => (s.owner_id ? [s.owner_id] : [])))]);
				return {
					maxRadius,
					settlements: found.map(({ s, distance }) => ({
						settlement: s.id,
						kind: s.kind,
						name: s.name,
						x: s.x,
						y: s.y,
						npc: !!kinds.get(s.kind)?.npc,
						ownerName: s.owner_id ? (owners[s.owner_id] ?? null) : null,
						distance: Math.round(distance * 10) / 10,
					})),
				};
			}
		}

		/* ----- commands (with generic forms) -------------------------------------------- */

		ctx.commands.add<null>({
			type: 'settlements.foundCapital',
			parse: () => null,
			async execute(api) {
				if (await service.capital(api, api.playerId)) throw fail('has_capital', 'You already have a capital');
				const centre = await map.findFreeSquare(api, 1);
				if (!centre) throw fail('map_full', 'Could not find free land, please retry', 503);
				// Named after its kind (an i18n key, shown translated) until the player renames it.
				await service.found(api, { kind: 'capital', ownerId: api.playerId, name: service.kind('capital').name, centre });
			},
			form: {
				title: text('Found your capital'),
				description: text('You have no capital yet. One will be founded on free land somewhere in the world.'),
				placement: 'global',
				fields: [],
				submitLabel: text('Found capital'),
				async prepare(api) {
					return (await service.capital(api, api.playerId)) ? false : {};
				},
			},
		});

		// Players found settlements by sending an expedition (a march mission, see the `settling`
		// plugin); this is the GM's instant, free version.
		ctx.commands.add<{ kind: string; tile: Tile; name: string }>({
			type: 'settlements.found',
			privileged: true,
			description:
				'Found a settlement for the player at once, free of charge (players send an expedition instead). Payload: { "kind": "city", "x": 1, "y": 2, "name"?: "..." }',
			parse: shape(
				{ kind: fields.id(), x: fields.int(-1e4, 1e4), y: fields.int(-1e4, 1e4), name: fields.optional(fields.text({ max: NAME_MAX })) },
				(p) => {
					const k = kinds.get(p.kind);
					if (!k || k.npc || p.kind === 'capital') throw fail('bad_payload', 'That kind of settlement cannot be founded');
					return { kind: p.kind, tile: { x: map.wrap(p.x), y: map.wrap(p.y) }, name: p.name ?? k.name };
				},
			),
			async execute(api, { kind, tile, name }) {
				const reason = await service.foundable(api, api.playerId, kind, tile);
				if (reason) throw fail('cannot_found', reason, 409);
				await service.found(api, { kind, ownerId: api.playerId, name, centre: tile });
			},
			form: {
				title: text('Found a settlement at once'),
				placement: 'gm',
				fields: [
					{ name: 'kind', label: text('Type'), type: 'select', required: true },
					{ name: 'x', label: text('x'), type: 'number', required: true },
					{ name: 'y', label: text('y'), type: 'number', required: true },
					{ name: 'name', label: text('Name'), type: 'text', maxLength: NAME_MAX, placeholder: text('optional') },
				],
				submitLabel: text('Found'),
				async prepare() {
					return {
						options: {
							kind: service
								.kinds()
								.filter((k) => !k.npc && k.id !== 'capital')
								.map((k) => ({ value: k.id, label: keyText(k.name) })),
						},
					};
				},
			},
		});

		const outerForm = (privileged: boolean) => ({
			// The GM form sends one "settlement@x,y" value; the API the settlement and x, y.
			parse: shape(
				{
					target: fields.optional(fields.text({ max: 300 })),
					settlement: fields.optional(fields.id()),
					x: fields.optional(fields.int(-1e4, 1e4)),
					y: fields.optional(fields.int(-1e4, 1e4)),
				},
				(p) => {
					const [settlement, at] = p.target ? p.target.split('@') : [p.settlement, `${p.x},${p.y}`];
					const [x, y] = (at ?? '').split(',').map(Number);
					if (!settlement || !Number.isInteger(x) || !Number.isInteger(y)) throw fail('bad_payload', 'tile must be integer coordinates');
					return { settlement, tile: { x: map.wrap(x), y: map.wrap(y) } };
				},
			),
			async execute(api: EngineApi, { settlement, tile }: { settlement: string; tile: Tile }) {
				const s = privileged ? await service.get(api, settlement) : await service.requireOwned(api, settlement);
				if (!s) throw fail('not_found', 'No such settlement', 404);
				if (!privileged) {
					const extra =
						s.districts.filter((d) => d.type === service.kind(s.kind).outer?.type).length - (service.kind(s.kind).outer?.initial ?? 0);
					const unit = service.kind(s.kind).outer?.cost?.(api) ?? {};
					await resources.spend(api, entity(s.id), Object.fromEntries(Object.entries(unit).map(([r, n]) => [r, n * (extra + 1)])));
				}
				await service.addOuter(api, s.id, tile, { ignoreTechLimit: privileged });
			},
		});

		ctx.commands.add<{ settlement: string; tile: Tile }>({
			type: 'settlements.addOuter',
			...outerForm(false),
			// Built from the City page's district grid, from `settlements.detail`'s `nextOuter`.
			description:
				'Build an outer city on a free tile next to the settlement (see nextOuter in settlements.detail). Payload: { "settlement", "x", "y" }',
		});

		ctx.commands.add<{ settlement: string; tile: Tile }>({
			type: 'settlements.addOuterBeyondTech',
			form: {
				title: text('Add an outer city beyond the research limit'),
				placement: 'gm',
				fields: [{ name: 'target', label: text('Where'), type: 'select', required: true }],
				submitLabel: text('Add outer city'),
				async prepare(api) {
					const options: { value: string; label: UiText }[] = [];
					for (const s of await service.mine(api, api.playerId)) {
						for (const t of await service.outerCandidates(api, s))
							options.push({ value: `${s.id}@${t.x},${t.y}`, label: text('{0} → ({1}, {2})', { 0: service.nameText(s), 1: t.x, 2: t.y }) });
					}
					return options.length ? { options: { target: options } } : false;
				},
			},
			privileged: true,
			description:
				'Add an outer city ignoring the research limit (what an expansion item will do), free of charge. Payload: { "settlement": "<id>", "x": 1, "y": 2 }',
			...outerForm(true),
		});

		ctx.commands.add<{ settlement: string; name: string }>({
			type: 'settlements.rename',
			parse: shape({ settlement: fields.id(), name: fields.text({ max: NAME_MAX }) }),
			async execute(api, { settlement, name }) {
				const s = await service.requireOwned(api, settlement);
				s.name = name;
				api.write(api.db.prepare('UPDATE settlements_settlements SET name = ? WHERE id = ?').bind(name, s.id));
			},
			form: {
				title: text('Rename'),
				placement: 'settlement',
				fields: [
					{ name: 'settlement', label: text('settlement'), type: 'hidden' },
					{ name: 'name', label: text('New name'), type: 'text', required: true, maxLength: NAME_MAX },
				],
				submitLabel: text('Rename'),
				async prepare(api, params): Promise<FormPatch | false> {
					const s = await service.resolve(api, params);
					if (!s) return false;
					// Never renamed: its name is the kind's i18n key, which must not land in the text box (it is a
					// value, shown untranslated, and would be saved as the name). Shown translated instead.
					if (ctx.services.get('i18n').isKey(s.name))
						return { defaults: { settlement: s.id }, description: text('Current name: {0}', { 0: keyText(s.name) }) };
					return { defaults: { settlement: s.id, name: s.name } };
				},
			},
		});

		/* ----- GM reports --------------------------------------------------------------- */

		ctx.reports.add({
			id: 'settlements.list',
			description: 'Settlements, optionally filtered by `kind` and/or `owner` (player id).',
			example: { kind: 'capital', limit: 50 },
			async run(api, params) {
				const p = shape({
					kind: fields.optional(fields.id()),
					owner: fields.optional(fields.id()),
					limit: fields.orElse(fields.int(1, 500), 50),
				})(params);
				const where: string[] = [];
				const binds: unknown[] = [];
				if (p.kind) (where.push('kind = ?'), binds.push(p.kind));
				if (p.owner) (where.push('owner_id = ?'), binds.push(p.owner));
				const limit = p.limit;
				const { results } = await api.db
					.prepare(
						`SELECT owner_id AS playerId, id, name, kind, x, y,
						 (SELECT COUNT(*) FROM settlements_districts d WHERE d.settlement_id = s.id AND d.idx > 0) AS extraDistricts
						 FROM settlements_settlements s ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at LIMIT ?`,
					)
					.bind(...binds, Math.floor(limit))
					.all();
				return results;
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.page({ id: 'city', label: 'Overview', order: 0 });
		ui.block({ page: '*', column: 'left', widget: 'settlement.switcher', order: -100 });
		ui.block({
			page: 'city',
			column: 'left',
			widget: 'ui.cells',
			order: 10,
			props: { view: 'settlements.districts', filter: 'city.district' },
		});
	},
});
