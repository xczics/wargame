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
	GameError,
	numberInRange,
	PluginError,
	type ReadApi,
	type ViewParams,
} from '../../kernel';
import { requestContext } from '../../runtime/context';
import type { MapTile, SettlementDetail, SettlementSummary } from '../../shared/api';
import type { Cost } from '../resources';
import type { Tile } from '../world-map';
import rulesCsv from './data/rules.csv?raw';

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
	mine(api: ReadApi, ownerId: string): Promise<Settlement[]>;
	capital(api: ReadApi, ownerId: string): Promise<Settlement | null>;
	/** Resolve `?settlement=` (default: capital) to a settlement the acting player owns. */
	resolve(api: ReadApi, params: ViewParams): Promise<Settlement | null>;
	district(settlement: Settlement, districtId: string): { district: District; template: DistrictTemplate };
	/** Create a settlement (claims tiles, creates districts and its resource pool). Returns its id. */
	found(api: EngineApi, input: { kind: string; ownerId: string | null; name: string; centre: Tile }): Promise<string>;
	/** Free tiles where the next outer city may go. */
	outerCandidates(api: ReadApi, settlement: Settlement): Promise<Tile[]>;
	/** Add an outer city. `ignoreTechLimit` (items) still respects the hard limit. */
	addOuter(api: EngineApi, settlementId: string, tile: Tile, options?: { ignoreTechLimit?: boolean }): Promise<void>;
	addDetailExtender(extender: DetailExtender): void;
	/** Add building slots to a district (e.g. an item raising an outer city's slots). */
	addSlots(api: EngineApi, settlementId: string, districtId: string, n: number): Promise<void>;
	/** Let a district type of a kind accept one more building category (e.g. a plugin's new "arena"). */
	allowCategory(kindId: string, districtType: string, category: string): void;
	/** Extra text for a map tile shown in choices (e.g. its terrain). Must only read. */
	addTileLabel(label: (api: ReadApi, tile: Tile) => Promise<string | null>): void;
	/** "(x, y)" plus every tile label. */
	tileLabel(api: ReadApi, tile: Tile): Promise<string>;
	/** Called inside `found`, once the new settlement exists (e.g. to give it starting buildings). */
	onFounded(listener: (api: EngineApi, settlement: Settlement) => Promise<void>): void;
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

function randomInt(min: number, max: number) {
	return min + (crypto.getRandomValues(new Uint32Array(1))[0] % (max - min + 1));
}

function parseName(raw: unknown, fallback?: string): string {
	const name = typeof raw === 'string' ? raw.trim() : '';
	if (!name) {
		if (fallback) return fallback;
		throw new GameError('bad_payload', 'name is required');
	}
	if (name.length > NAME_MAX) throw new GameError('bad_payload', `name: at most ${NAME_MAX} characters`);
	return name;
}

function parseTile(raw: unknown, wrap: (v: number) => number): Tile {
	// Accepts {x, y} numbers or a "x,y" string (from form selects).
	const r = raw as { x?: unknown; y?: unknown } | string | null;
	const [x, y] = typeof r === 'string' ? r.split(',').map(Number) : [Number(r?.x), Number(r?.y)];
	if (!Number.isInteger(x) || !Number.isInteger(y)) throw new GameError('bad_payload', 'tile must be integer coordinates');
	return { x: wrap(x), y: wrap(y) };
}

const str = (raw: unknown, name: string) => {
	if (typeof raw !== 'string' || !raw) throw new GameError('bad_payload', `${name} is required`);
	return raw;
};

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
	dependsOn: ['accounts', 'world-map', 'stats', 'resources', 'timeline'],
	setup(ctx) {
		const accounts = ctx.services.get('accounts');
		const map = ctx.services.get('worldMap');
		const stats = ctx.services.get('stats');
		const resources = ctx.services.get('resources');
		const timeline = ctx.services.get('timeline');
		const kinds = new Map<string, SettlementKind>();
		const extenders: DetailExtender[] = [];
		const tileLabels: ((api: ReadApi, tile: Tile) => Promise<string | null>)[] = [];
		const foundedListeners: ((api: EngineApi, settlement: Settlement) => Promise<void>)[] = [];

		const outerTech = ctx.config.define('outerTechLimit', {
			description: 'Outer cities per capital/city before research bonuses. Research may raise it (up to 8 without items).',
			default: () => RULES.outerTechLimit as number,
			parse: numberInRange(1, RING1),
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
				if (kind.layout === 'ring' && (!kind.outer || kind.outer.initial < 1)) {
					throw new PluginError(`Ring settlement "${kind.id}" needs an outer template with initial >= 1`);
				}
				kinds.set(kind.id, kind);
				if (kind.limit) {
					const limit = kind.limit;
					stats.define({
						id: `settlements.limit.${kind.id}`,
						description: `Max ${kind.name} per player`,
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

			get(api, id) {
				return api.memo(`settlements:get:${id}`, async () => {
					const row = await api.db.prepare('SELECT * FROM settlements_settlements WHERE id = ?').bind(id).first<SettlementRow>();
					if (!row) return null;
					return toSettlement(row, (await loadDistricts(api, [id])).get(id)!);
				});
			},
			async requireOwned(api, id) {
				const s = await service.get(api, id);
				if (!s || s.ownerId !== api.playerId) throw new GameError('not_found', 'No such settlement', 404);
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
				if (!district) throw new GameError('not_found', 'No such district', 404);
				const kind = service.kind(settlement.kind);
				const template = district.type === kind.outer?.type ? kind.outer : kind.centre;
				return { district, template };
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
					if (free.length < kind.outer!.initial) throw new GameError('no_room', 'Not enough free land around that tile', 409);
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

			async addOuter(api, settlementId, tile, { ignoreTechLimit = false } = {}) {
				const s = await service.get(api, settlementId);
				if (!s) throw new GameError('not_found', 'No such settlement', 404);
				const kind = service.kind(s.kind);
				if (kind.layout !== 'ring') throw new GameError('no_outer', `${kind.name} has no outer cities`);
				const outer = s.districts.filter((d) => d.type === kind.outer!.type).length;
				const hard = await stats.get(api, 'settlements.outer.hard', entity(s.id));
				const tech = Math.min(hard, await stats.get(api, 'settlements.outer.tech', entity(s.id)));
				if (outer >= (ignoreTechLimit ? hard : tech)) {
					throw new GameError(
						'outer_limit',
						ignoreTechLimit || outer >= hard ? 'Outer city limit reached' : 'Research more to build more outer cities',
					);
				}
				const t = { x: map.wrap(tile.x), y: map.wrap(tile.y) };
				if (!(await service.outerCandidates(api, s)).some((c) => c.x === t.x && c.y === t.y)) {
					throw new GameError('bad_tile', 'An outer city must go on a free tile next to this settlement (inner ring first)');
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

			addDetailExtender: (e) => void extenders.push(e),
			onFounded: (l) => void foundedListeners.push(l),
			addTileLabel: (l) => void tileLabels.push(l),
			async tileLabel(api, tile) {
				const extra = (await Promise.all(tileLabels.map((l) => l(api, tile)))).filter(Boolean);
				return [`(${tile.x}, ${tile.y})`, ...extra].join(' · ');
			},
			async addSlots(api, settlementId, districtId, n) {
				const s = await service.get(api, settlementId);
				if (!s) throw new GameError('not_found', 'No such settlement', 404);
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

		// Resource pools: `?settlement=` (must be owned) or the capital.
		resources.setHolderResolver(async (api, params) => {
			const s = await service.resolve(api, params);
			if (!s) throw new GameError('no_settlement', 'You have no settlement yet', 404);
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

		ctx.views.add({
			id: 'settlements.detail',
			async compute(api, params): Promise<SettlementDetail | null> {
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
				for (const extend of extenders) await extend(api, s, detail);
				return detail;
			},
		});

		// Map window: `?x=&y=&r=` (r <= 25), default centred on the capital.
		ctx.views.add({
			id: 'settlements.map',
			async compute(api, params): Promise<MapTile[]> {
				const capital = await service.capital(api, api.playerId);
				const x = params.x !== undefined ? Number(params.x) : (capital?.x ?? 0);
				const y = params.y !== undefined ? Number(params.y) : (capital?.y ?? 0);
				const r = Math.min(25, Math.max(0, Math.floor(Number(params.r ?? 7))));
				if (!Number.isFinite(x) || !Number.isFinite(y)) throw new GameError('bad_params', 'x and y must be numbers');
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

		/* ----- commands (with generic forms) -------------------------------------------- */

		ctx.commands.add<null>({
			type: 'settlements.foundCapital',
			parse: () => null,
			async execute(api) {
				if (await service.capital(api, api.playerId)) throw new GameError('has_capital', 'You already have a capital');
				const centre = await map.findFreeSquare(api, 1);
				if (!centre) throw new GameError('map_full', 'Could not find free land, please retry', 503);
				await service.found(api, { kind: 'capital', ownerId: api.playerId, name: 'Capital', centre });
			},
			form: {
				title: 'Found your capital',
				description: 'You have no capital yet. One will be founded on free land somewhere in the world.',
				placement: 'global',
				fields: [],
				submitLabel: 'Found capital',
				async prepare(api) {
					return (await service.capital(api, api.playerId)) ? false : {};
				},
			},
		});

		ctx.commands.add<{ from: string; kind: string; tile: Tile; name: string }>({
			type: 'settlements.found',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				const kind = str(p.kind, 'kind');
				const k = kinds.get(kind);
				if (!k || k.npc || kind === 'capital') throw new GameError('bad_payload', 'That kind of settlement cannot be founded');
				return { from: str(p.from, 'from'), kind, tile: parseTile({ x: p.x, y: p.y }, map.wrap), name: parseName(p.name, k.name) };
			},
			async execute(api, { from, kind: kindId, tile, name }) {
				const source = await service.requireOwned(api, from);
				const kind = service.kind(kindId);
				if (kind.limit) {
					const have = (await service.mine(api, api.playerId)).filter((s) => s.kind === kindId).length;
					if (have >= (await stats.get(api, `settlements.limit.${kindId}`, `player:${api.playerId}`))) {
						throw new GameError('limit', `You cannot have more of: ${kind.name}`);
					}
				}
				// Check the land before charging, so a taken tile is reported as such.
				if ((await map.occupants(api, [tile])).size) throw new GameError('tile_taken', 'That tile is already occupied', 409);
				if (kind.foundCost) await resources.spend(api, entity(source.id), kind.foundCost(api));
				await service.found(api, { kind: kindId, ownerId: api.playerId, name, centre: tile });
			},
			form: {
				title: 'Found a settlement here',
				placement: 'tile',
				fields: [
					{ name: 'kind', label: 'Type', type: 'select', required: true },
					{ name: 'name', label: 'Name', type: 'text', maxLength: NAME_MAX, placeholder: 'optional' },
					{ name: 'from', label: 'Paid by', type: 'hidden' },
					{ name: 'x', label: 'x', type: 'hidden' },
					{ name: 'y', label: 'y', type: 'hidden' },
				],
				submitLabel: 'Found',
				async prepare(api, params) {
					const source = await service.resolve(api, params);
					if (!source || params.x === undefined || params.y === undefined) return false;
					const tile = parseTile({ x: params.x, y: params.y }, map.wrap);
					if ((await map.occupants(api, [tile])).size) return false;
					const mine = await service.mine(api, api.playerId);
					const options: { value: string; label: string }[] = [];
					for (const k of service.kinds()) {
						if (k.npc || k.id === 'capital') continue;
						const have = mine.filter((s) => s.kind === k.id).length;
						const limit = k.limit ? await stats.get(api, `settlements.limit.${k.id}`, `player:${api.playerId}`) : Infinity;
						if (have >= limit) continue;
						const cost = k.foundCost
							? Object.entries(k.foundCost(api))
									.map(([r, n]) => `${n} ${r}`)
									.join(', ')
							: 'free';
						options.push({ value: k.id, label: `${k.name} (${have}/${limit === Infinity ? '∞' : limit}) — ${cost}` });
					}
					if (!options.length) return false;
					return {
						defaults: { from: source.id, x: tile.x, y: tile.y },
						options: { kind: options },
						description: `Tile (${tile.x}, ${tile.y}), paid by ${source.name}.`,
					};
				},
			},
		});

		const outerForm = (privileged: boolean) => ({
			parse(raw: unknown) {
				const p = { ...((raw ?? {}) as Record<string, unknown>) };
				// The GM form sends one "settlement@x,y" value.
				if (typeof p.target === 'string') [p.settlement, p.tile] = p.target.split('@');
				return { settlement: str(p.settlement, 'settlement'), tile: parseTile(p.tile ?? { x: p.x, y: p.y }, map.wrap) };
			},
			async execute(api: EngineApi, { settlement, tile }: { settlement: string; tile: Tile }) {
				const s = privileged ? await service.get(api, settlement) : await service.requireOwned(api, settlement);
				if (!s) throw new GameError('not_found', 'No such settlement', 404);
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
			form: {
				title: 'Build an outer city',
				description: 'Outer cities hold resource buildings. They share this settlement’s resources.',
				placement: 'settlement',
				fields: [
					{ name: 'settlement', label: 'settlement', type: 'hidden' },
					{ name: 'tile', label: 'Where', type: 'select', required: true },
				],
				submitLabel: 'Build',
				async prepare(api, params) {
					const s = await service.resolve(api, params);
					if (!s || service.kind(s.kind).layout !== 'ring') return false;
					const kind = service.kind(s.kind);
					const outer = s.districts.filter((d) => d.type === kind.outer!.type).length;
					const hard = await stats.get(api, 'settlements.outer.hard', entity(s.id));
					const tech = Math.min(hard, await stats.get(api, 'settlements.outer.tech', entity(s.id)));
					if (outer >= tech) return false;
					const candidates = await service.outerCandidates(api, s);
					if (!candidates.length) return false;
					const extra = outer - kind.outer!.initial;
					const cost = Object.entries(kind.outer!.cost?.(api) ?? {})
						.map(([r, n]) => `${n * (extra + 1)} ${r}`)
						.join(', ');
					return {
						defaults: { settlement: s.id },
						options: {
							tile: await Promise.all(candidates.map(async (t) => ({ value: `${t.x},${t.y}`, label: await service.tileLabel(api, t) }))),
						},
						description: `${outer} / ${tech} outer cities. Cost: ${cost}.`,
					};
				},
			},
		});

		ctx.commands.add<{ settlement: string; tile: Tile }>({
			type: 'settlements.addOuterBeyondTech',
			form: {
				title: 'Add an outer city beyond the research limit',
				placement: 'gm',
				fields: [{ name: 'target', label: 'Where', type: 'select', required: true }],
				submitLabel: 'Add outer city',
				async prepare(api) {
					const options: { value: string; label: string }[] = [];
					for (const s of await service.mine(api, api.playerId)) {
						for (const t of await service.outerCandidates(api, s))
							options.push({ value: `${s.id}@${t.x},${t.y}`, label: `${s.name} → (${t.x}, ${t.y})` });
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
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				return { settlement: str(p.settlement, 'settlement'), name: parseName(p.name) };
			},
			async execute(api, { settlement, name }) {
				const s = await service.requireOwned(api, settlement);
				s.name = name;
				api.write(api.db.prepare('UPDATE settlements_settlements SET name = ? WHERE id = ?').bind(name, s.id));
			},
			form: {
				title: 'Rename',
				placement: 'settlement',
				fields: [
					{ name: 'settlement', label: 'settlement', type: 'hidden' },
					{ name: 'name', label: 'New name', type: 'text', required: true, maxLength: NAME_MAX },
				],
				submitLabel: 'Rename',
				async prepare(api, params) {
					const s = await service.resolve(api, params);
					return s ? { defaults: { settlement: s.id, name: s.name } } : false;
				},
			},
		});

		/* ----- GM reports --------------------------------------------------------------- */

		ctx.reports.add({
			id: 'settlements.list',
			description: 'Settlements, optionally filtered by `kind` and/or `owner` (player id).',
			example: { kind: 'capital', limit: 50 },
			async run(api, params) {
				const p = (params ?? {}) as Record<string, unknown>;
				const where: string[] = [];
				const binds: unknown[] = [];
				if (typeof p.kind === 'string') (where.push('kind = ?'), binds.push(p.kind));
				if (typeof p.owner === 'string') (where.push('owner_id = ?'), binds.push(p.owner));
				const limit = p.limit === undefined ? 50 : numberInRange(1, 500)(p.limit);
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
	},
});
