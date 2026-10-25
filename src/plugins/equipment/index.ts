/**
 * Equipment (docs/design/gameplay.md §10): pieces a player owns, each with its own rolled
 * numbers, worn by heroes one per slot. A piece nobody wears is stored in a settlement (stat
 * `equipment.storage`, raised by buildings such as an armory); only heroes attached to that
 * settlement can take it, so heroes of one settlement share and swap their gear there.
 *
 * The system knows none of the content: slots, bases (names, icons), rarities and how pieces
 * are made (`create`) come from content plugins, and so do most effects. A piece's stats are
 * free-form keys; the system only applies "attr.<attribute>" (added to the wearer's attributes
 * through the heroes' attribute bonus). Others (adventure numbers, battle bonuses...) are read
 * by whoever connects them (`worn`).
 */
import {
	csvRules,
	definePlugin,
	derive,
	type EngineApi,
	type FlatContext,
	fields,
	gameErrors,
	numberInRange,
	PluginError,
	type ReadApi,
	type RuleView,
	shape,
	chunks,
	derivedKind,
} from '../../kernel';
import type { EquipmentItems, EquipmentSmelt, EquipmentTotals } from '../../shared/api';
import type { TallyData } from '../../shared/ui';
import type { Hero } from '../heroes';
import type { Cost } from '../resources';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, literal, uiTexts } from '../../shared/i18n';

// Its derived values (`api.derived`): key prefix and shape version, one place for every path.
const CAPACITY = derivedKind('equipment:capacity', 1);

const fail = gameErrors('equipment');
const text = uiTexts('equipment');

const RULES = csvRules(rulesCsv);

export interface SlotDef {
	id: string;
	name: string;
	icon?: string;
	/**
	 * Slots of a group (e.g. "accessory") share a per-hero limit (`setGroupLimit`): a hero wears at
	 * most that many of them, still one per slot. Without a group: one per hero.
	 */
	group?: string;
}
export interface BaseDef {
	id: string;
	name: string;
	slot: string;
	tier: number;
	icon?: string;
	/** Heroes below this level cannot wear it. */
	minLevel?: number;
	/** The set it belongs to (name: text to translate). */
	set?: { id: string; name: string };
}
export interface RarityDef {
	id: string;
	name: string;
	/** Display order (1 = commonest). */
	order: number;
}
export interface Piece {
	id: string;
	playerId: string;
	base: string;
	slot: string;
	tier: number;
	rarity: string;
	stats: Record<string, number>;
	hero: string | null;
	/** Where it is stored while nobody wears it. */
	settlement: string | null;
}

export interface EquipmentService {
	defineSlot(def: SlotDef): void;
	defineBase(def: BaseDef): void;
	defineRarity(def: RarityDef): void;
	bases(): readonly BaseDef[];
	rarities(): readonly RarityDef[];
	slots(): readonly SlotDef[];
	/** Store a new piece in one of the player's settlements; null if its storage is full (nothing is created). */
	create(
		api: EngineApi,
		playerId: string,
		settlementId: string,
		piece: { base: string; rarity: string; stats: Record<string, number> },
	): Promise<Piece | null>;
	/** `create`, refused ("No room to store it here", ours) when the storage is full. */
	createOrRefuse(
		api: EngineApi,
		playerId: string,
		settlementId: string,
		piece: { base: string; rarity: string; stats: Record<string, number> },
	): Promise<Piece>;
	/** The pieces a hero wears. */
	worn(api: ReadApi, heroId: string): Promise<Piece[]>;
	/** The summed stats of what a hero wears (one stored row per player; what bonuses need on every sync). */
	wornStats(api: ReadApi, heroId: string): Promise<Record<string, number>>;
	/**
	 * What smelting a piece gives (content decides; default nothing): from the rules, its base and its colour only (the
	 * browser shows it from the static `equipment.smelt`, baked by base and colour).
	 */
	setSmeltValue(value: (api: ReadApi, piece: Piece) => Cost): void;
	/** How many slots of `group` a hero may fill (default 0): from the rules and the hero alone. */
	setGroupLimit(group: string, limit: (rules: RuleView, hero: Hero) => number): void;
}

declare module '../../kernel' {
	interface ServiceMap {
		equipment: EquipmentService;
	}
}

interface Row {
	id: string;
	player_id: string;
	base: string;
	slot: string;
	tier: number;
	rarity: string;
	stats: string;
	hero_id: string | null;
	settlement_id: string | null;
}
const toPiece = (r: Row): Piece => ({
	id: r.id,
	playerId: r.player_id,
	base: r.base,
	slot: r.slot,
	tier: r.tier,
	rarity: r.rarity,
	stats: JSON.parse(r.stats),
	hero: r.hero_id,
	settlement: r.settlement_id,
});

export default definePlugin({
	id: 'equipment',
	version: '0.1.0',
	description: 'Equipment: pieces with rolled stats, worn by heroes one per slot',
	dependsOn: ['heroes', 'settlements', 'resources', 'stats', 'timeline', 'buildings', 'ui', 'i18n'],
	tables: ['equipment_items', 'equipment_totals'],
	setup(ctx) {
		// Other plugins' tables, for the lists below that name what is read on the way (not their names).
		const TIMELINE = ctx.tablesOf('timeline');
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const heroes = ctx.services.get('heroes');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const slots = new Map<string, SlotDef>();
		const bases = new Map<string, BaseDef>();
		const rarities = new Map<string, RarityDef>();
		let smeltValue = (_api: ReadApi, _p: Piece): Cost => ({});
		const groupLimits = new Map<string, (rules: RuleView, hero: Hero) => number>();

		const storage = ctx.config.define('storage', {
			description: 'Pieces a settlement stores before bonuses (buildings such as the armory add to stat equipment.storage).',
			default: () => RULES.storage as number,
			parse: numberInRange(0, 100_000),
		});
		stats.define({ id: 'equipment.storage', description: 'equipment storage', base: (api) => storage.get(api), integer: true, min: 0 });

		/**
		 * A player's pieces, loaded once per call; changes in a command are reflected. Pieces from
		 * before storage existed, or worn by a hero since dismissed, count as stored in the capital.
		 */
		const loadMine = (api: ReadApi, playerId: string) =>
			api.memo(
				`equipment:mine:${playerId}`,
				async () => {
					const { results } = await api.db
						.prepare('SELECT * FROM equipment_items WHERE player_id = ? ORDER BY created_at')
						.bind(playerId)
						.all<Row>();
					const heroIds = new Set((await heroes.list(api, playerId)).map((h) => h.id));
					const capital = (await settlements.capital(api, playerId))?.id ?? null;
					return results.map(toPiece).map((p) => {
						if (p.hero && !heroIds.has(p.hero)) p.hero = null;
						if (!p.hero && !p.settlement) p.settlement = capital;
						return p;
					});
				},
				{ current: true },
			);
		/**
		 * Summed stats of what each of a player's heroes wears, kept in one row (`equipment_totals`) and rewritten
		 * whenever a piece goes on or off: bonuses are read on every sync, pieces change rarely. Missing row = nothing worn.
		 */
		type Totals = Record<string, Record<string, number>>;
		const loadTotals = (api: ReadApi, playerId: string) =>
			api.memo(`equipment:totals:${playerId}`, async () => {
				const row = await api.db
					.prepare('SELECT totals FROM equipment_totals WHERE player_id = ?')
					.bind(playerId)
					.first<{ totals: string }>();
				return (row ? JSON.parse(row.totals) : {}) as Totals;
			});
		const totalsFrom = (pieces: Piece[]) => {
			const out: Totals = {};
			for (const p of pieces) {
				if (!p.hero) continue;
				const sum = (out[p.hero] ??= {});
				for (const [k, v] of Object.entries(p.stats)) sum[k] = (sum[k] ?? 0) + v;
			}
			return out;
		};
		// Summed once per list (a heroes page asks for every hero: each sum would walk every piece), until a piece moves,
		// comes or goes (each of those drops what was summed).
		let summed = new WeakMap<Piece[], Totals>();
		const totalsOf = (pieces: Piece[]) => {
			let t = summed.get(pieces);
			if (!t) summed.set(pieces, (t = totalsFrom(pieces)));
			return t;
		};
		const moved = () => void (summed = new WeakMap());
		// A piece's place and the player's totals, as both forms of a command write them.
		const placeWrite = (db: D1Database, piece: Piece) =>
			db.prepare('UPDATE equipment_items SET hero_id = ?, settlement_id = ? WHERE id = ?').bind(piece.hero, piece.settlement, piece.id);
		const totalsWrite = (db: D1Database, owner: string, pieces: Piece[]) =>
			db
				.prepare(
					'INSERT INTO equipment_totals (player_id, totals) VALUES (?, ?) ON CONFLICT (player_id) DO UPDATE SET totals = excluded.totals',
				)
				.bind(owner, JSON.stringify(totalsFrom(pieces)));
		/** Put a piece on a hero or into a settlement's storage. */
		const place = (api: EngineApi, piece: Piece, at: { hero: string } | { settlement: string }) => {
			moved();
			piece.hero = 'hero' in at ? at.hero : null;
			piece.settlement = 'settlement' in at ? at.settlement : null;
			api.write(placeWrite(api.db, piece));
			const owner = piece.playerId;
			api.beforeCommit(`equipment:totals:${owner}`, async () => api.write(totalsWrite(api.db, owner, await loadMine(api, owner))), {
				writes: ['equipment_totals'],
			});
		};
		const stored = async (api: ReadApi, playerId: string, settlementId: string) =>
			(await loadMine(api, playerId)).filter((p) => !p.hero && p.settlement === settlementId).length;
		/** Storage of a settlement, with its due timeline events (e.g. an armory finished) applied first. */
		const capacityOf = async (api: EngineApi, settlementId: string) => {
			await timeline.sync(api, settlements.entity(settlementId));
			return stats.get(api, 'equipment.storage', settlements.entity(settlementId));
		};
		const room = async (api: EngineApi, playerId: string, settlementId: string) =>
			(await capacityOf(api, settlementId)) - (await stored(api, playerId, settlementId));

		const statLabels = new Map<string, (text: string) => string>();
		const service: EquipmentService = {
			defineSlot(def) {
				if (slots.has(def.id)) throw new PluginError(`Equipment slot "${def.id}" defined twice`);
				slots.set(def.id, { ...def, name: ctx.services.get('i18n').own(def.name) });
			},
			defineBase(def) {
				if (bases.has(def.id)) throw new PluginError(`Equipment base "${def.id}" defined twice`);
				if (!slots.has(def.slot)) throw new PluginError(`Equipment base "${def.id}": unknown slot "${def.slot}"`);
				const own = ctx.services.get('i18n').own;
				// Its stats are named by the plugin defining it ("stat:<key>").
				statLabels.set(def.id, ctx.services.get('i18n').scope());
				bases.set(def.id, { ...def, name: own(def.name), ...(def.set ? { set: { ...def.set, name: own(def.set.name) } } : {}) });
			},
			defineRarity(def) {
				if (rarities.has(def.id)) throw new PluginError(`Equipment rarity "${def.id}" defined twice`);
				rarities.set(def.id, { ...def, name: ctx.services.get('i18n').own(def.name) });
			},
			bases: () => [...bases.values()],
			rarities: () => [...rarities.values()].sort((a, b) => a.order - b.order),
			slots: () => [...slots.values()],
			async createOrRefuse(api, playerId, settlementId, piece) {
				const made = await service.create(api, playerId, settlementId, piece);
				if (!made) throw full();
				return made;
			},
			async create(api, playerId, settlementId, { base: baseId, rarity, stats: rolled }) {
				const base = bases.get(baseId);
				if (!base) throw new PluginError(`Unknown equipment base "${baseId}"`);
				if (!rarities.has(rarity)) throw new PluginError(`Unknown equipment rarity "${rarity}"`);
				const mine = await loadMine(api, playerId);
				if ((await room(api, playerId, settlementId)) <= 0) return null;
				const piece: Piece = {
					id: crypto.randomUUID(),
					playerId,
					base: base.id,
					slot: base.slot,
					tier: base.tier,
					rarity,
					stats: rolled,
					hero: null,
					settlement: settlementId,
				};
				mine.push(piece);
				moved();
				api.write(
					api.db
						.prepare(
							'INSERT INTO equipment_items (id, player_id, base, slot, tier, rarity, stats, hero_id, settlement_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
						)
						.bind(piece.id, playerId, piece.base, piece.slot, piece.tier, rarity, JSON.stringify(rolled), settlementId, api.now),
				);
				return piece;
			},
			async worn(api, heroId) {
				const owner = (await heroes.get(api, heroId))?.playerId;
				return owner ? (await loadMine(api, owner)).filter((p) => p.hero === heroId) : [];
			},
			async wornStats(api, heroId) {
				const owner = (await heroes.get(api, heroId))?.playerId;
				if (!owner) return {};
				// The full list when this call has it (kept current by every change, e.g. right after equipping); else the stored row.
				const mine = api.peek<Piece[]>(`equipment:mine:${owner}`);
				const totals = mine ? totalsOf(await mine) : await loadTotals(api, owner);
				return { ...totals[heroId] };
			},
			setSmeltValue: (v) => void (smeltValue = v),
			setGroupLimit: (group, limit) => void groupLimits.set(group, limit),
		};
		ctx.services.provide('equipment', service);

		// "attr.<attribute>" stats add to the wearer's attributes.
		heroes.addAttributeBonus(async (api, hero) =>
			Object.fromEntries(
				Object.entries(await service.wornStats(api, hero.id)).flatMap(([k, v]) => (k.startsWith('attr.') ? [[k.slice(5), v]] : [])),
			),
		);

		const owned = async (api: EngineApi, id: string) => {
			const piece = (await loadMine(api, api.playerId)).find((p) => p.id === id);
			if (!piece) throw fail('not_found', 'No such piece', 404);
			return piece;
		};
		/** Only heroes at home on a duty they can leave at will may change what they wear. */
		const changeable = async (api: EngineApi, heroId: string) => {
			const hero = await heroes.requireOwned(api, api.playerId, heroId);
			heroes.requireFree(hero);
			await heroes.attributesChanging(api, hero.id);
			return hero;
		};
		const full = () => fail('storage_full', 'No room to store it here (an armory stores more)');

		/*
		 * Wearing and taking off on the fast path (`Command.flat`): the player's pieces and heroes in one batch, the storage
		 * of each settlement from its stored derived value. Only what the rows tell: a hero away, a listener that must
		 * read (a hero posted to a settlement banks its output first), a piece needing `loadMine`'s fix-ups, a settlement
		 * without a fresh capacity, anything to refuse: the regular way, which says why.
		 */
		const flatReads = (f: FlatContext) => ({
			pieces: f.db.prepare('SELECT * FROM equipment_items WHERE player_id = ? ORDER BY created_at').bind(f.playerId),
			heroes: heroes.flat.reads(f, f.playerId),
			due: timeline.flatPlayerDue(f),
		});
		const flatState = ({ rows, playerId }: { rows: Record<string, Record<string, unknown>[]>; playerId: string }) => {
			if ((rows.due[0] as { n: number }).n > 0) return null;
			const list = heroes.flat.heroes(rows.heroes).filter((h) => h.playerId === playerId);
			const ids = new Set(list.map((h) => h.id));
			const pieces = (rows.pieces as unknown as Row[]).map(toPiece);
			if (pieces.some((p) => (p.hero && !ids.has(p.hero)) || (!p.hero && !p.settlement))) return null;
			return { pieces, hero: (id: string) => list.find((h) => h.id === id) };
		};
		/** A hero that may change what it wears, and its listeners' writes; null: the regular way. */
		const flatChangeable = (hero: Hero | undefined) => (hero && heroes.flat.free(hero) ? heroes.flat.attributesChanging(hero) : null);
		const flatRoom = (derived: Record<string, unknown>, pieces: Piece[], settlementId: string) => {
			const capacity = derived[CAPACITY.key(settlementId)];
			return typeof capacity === 'number' ? capacity - pieces.filter((p) => !p.hero && p.settlement === settlementId).length : null;
		};

		ctx.commands.add<{ piece: string; hero: string }>({
			type: 'equipment.equip',
			description:
				'Put a piece on a hero: from the storage of its settlement, or from another hero of the same settlement. What it wore in that slot is stored there. Payload: { "piece", "hero" }',
			parse: shape({ piece: fields.id(), hero: fields.id() }),
			flat: {
				derived: () => [CAPACITY.all()],
				reads: (p, f) => flatReads(f),
				run(input) {
					const state = flatState(input);
					const piece = state?.pieces.find((p) => p.id === input.payload.piece);
					if (!state || !piece) return null;
					if (piece.hero === input.payload.hero) return [];
					const hero = state.hero(input.payload.hero);
					const from = piece.hero ? state.hero(piece.hero) : undefined;
					const writes = [...(flatChangeable(hero) ?? [null]), ...(piece.hero ? (flatChangeable(from) ?? [null]) : [])];
					if (!hero || writes.includes(null)) return null;
					if ((from ? from.home : piece.settlement) !== hero.home) return null;
					const old = state.pieces.find((p) => p.hero === hero.id && p.slot === piece.slot);
					const group = slots.get(piece.slot)?.group;
					if (group && !old) {
						const limit = groupLimits.get(group)?.(input, hero) ?? 0;
						if (state.pieces.filter((p) => p.hero === hero.id && slots.get(p.slot)?.group === group).length >= limit) return null;
					}
					if (old && from && !((flatRoom(input.derived, state.pieces, hero.home) ?? 0) > 0)) return null;
					const base = bases.get(piece.base);
					if (base?.minLevel && hero.level < base.minLevel) return null;
					// Off first: the unique index (hero, slot) is checked statement by statement.
					const out = writes as D1PreparedStatement[];
					if (old) {
						Object.assign(old, { hero: null, settlement: hero.home });
						out.push(placeWrite(input.db, old));
					}
					Object.assign(piece, { hero: hero.id, settlement: null });
					out.push(placeWrite(input.db, piece), totalsWrite(input.db, input.playerId, state.pieces));
					return out;
				},
			},
			async execute(api, { piece: pieceId, hero: heroId }) {
				const piece = await owned(api, pieceId);
				if (piece.hero === heroId) return;
				const hero = await changeable(api, heroId);
				const from = piece.hero ? await changeable(api, piece.hero) : null;
				if ((from ? from.home : piece.settlement) !== hero.home)
					throw fail('blocked', 'Only heroes of the settlement where it is can take it');
				const old = (await loadMine(api, api.playerId)).find((p) => p.hero === hero.id && p.slot === piece.slot);
				const group = slots.get(piece.slot)?.group;
				if (group && !old) {
					const limit = groupLimits.get(group)?.(api, hero) ?? 0;
					const worn = (await loadMine(api, api.playerId)).filter((p) => p.hero === hero.id && slots.get(p.slot)?.group === group).length;
					if (worn >= limit)
						throw fail('blocked', limit ? text('This hero wears at most {0} of these', { 0: limit }) : 'This hero cannot wear these');
				}
				// From storage, the old piece takes its place; from another hero, it needs room.
				if (old && from && (await room(api, api.playerId, hero.home)) <= 0) throw full();
				const base = bases.get(piece.base);
				if (base?.minLevel && hero.level < base.minLevel) throw fail('blocked', text('Needs a hero of level {0}', { 0: base.minLevel }));
				// Off first: the unique index (hero, slot) is checked statement by statement.
				if (old) place(api, old, { settlement: hero.home });
				place(api, piece, { hero: hero.id });
			},
		});
		ctx.commands.add<{ piece: string }>({
			type: 'equipment.unequip',
			description: 'Take a piece off its hero and store it in the hero\'s settlement. Payload: { "piece" }',
			parse: shape({ piece: fields.id() }),
			flat: {
				derived: () => [CAPACITY.all()],
				reads: (p, f) => flatReads(f),
				run(input) {
					const state = flatState(input);
					const piece = state?.pieces.find((p) => p.id === input.payload.piece);
					if (!state || !piece) return null;
					if (!piece.hero) return [];
					const hero = state.hero(piece.hero);
					const writes = flatChangeable(hero);
					if (!hero || !writes || !((flatRoom(input.derived, state.pieces, hero.home) ?? 0) > 0)) return null;
					Object.assign(piece, { hero: null, settlement: hero.home });
					return [...writes, placeWrite(input.db, piece), totalsWrite(input.db, input.playerId, state.pieces)];
				},
			},
			async execute(api, { piece: pieceId }) {
				const piece = await owned(api, pieceId);
				if (!piece.hero) return;
				const hero = await changeable(api, piece.hero);
				if ((await room(api, api.playerId, hero.home)) <= 0) throw full();
				place(api, piece, { settlement: hero.home });
			},
		});
		ctx.commands.add<{ piece: string }>({
			type: 'equipment.smelt',
			description: 'Smelt a stored piece for a little material, kept by the settlement storing it. Payload: { "piece" }',
			parse: shape({ piece: fields.id() }),
			async execute(api, { piece: pieceId }) {
				const piece = await owned(api, pieceId);
				if (piece.hero || !piece.settlement) throw fail('blocked', 'Take it off first');
				const s = await settlements.requireOwned(api, piece.settlement);
				for (const [r, n] of Object.entries(smeltValue(api, piece))) if (n > 0) await resources.add(api, settlements.entity(s.id), r, n);
				const mine = await loadMine(api, api.playerId);
				mine.splice(mine.indexOf(piece), 1);
				moved();
				api.write(api.db.prepare('DELETE FROM equipment_items WHERE id = ?').bind(piece.id));
			},
		});

		/** What a stored piece is, for the bulk smelting filters and the storage list's: its colour, set ("" = none) and slot. */
		const facets = (p: Piece) => ({ rarity: p.rarity, set: bases.get(p.base)?.set?.id ?? '', slot: p.slot });
		/** The colours, sets and slots these pieces have (none other offered), by facet. */
		const facetChoices = (pieces: Piece[]) => {
			const used = (key: 'rarity' | 'set' | 'slot') => new Set(pieces.map((p) => facets(p)[key]));
			const sets = new Map(service.bases().flatMap((b) => (b.set ? [[b.set.id, b.set.name] as const] : [])));
			return {
				rarity: service
					.rarities()
					.filter((r) => used('rarity').has(r.id))
					.map((r) => ({ value: r.id, label: keyText(r.name) })),
				set: [...used('set')].filter(Boolean).map((id) => ({ value: id, label: sets.has(id) ? keyText(sets.get(id)!) : literal(id) })),
				slot: service
					.slots()
					.filter((x) => used('slot').has(x.id))
					.map((x) => ({ value: x.id, label: keyText(x.name) })),
			};
		};
		// Many stored pieces at once, by colour, set and slot (user 2026-10-05: "装备提供批量拆解选项，支持按颜色，套装，
		// 或种类筛选后一键全部拆解。"); worn ones never. On its own entry, opened from the storage list.
		ctx.commands.add<{ settlement: string; rarity?: string; set?: string; slot?: string }>({
			type: 'equipment.smeltMany',
			description:
				'Smelt every piece stored in a settlement that matches (none given = any): materials kept there. Payload: { "settlement", "rarity"?, "set"?, "slot"? }',
			form: {
				title: text('Smelt in bulk'),
				placement: 'equipment-smelt',
				fields: [
					{ name: 'settlement', label: text('Settlement'), type: 'hidden' },
					{ name: 'rarity', label: text('Colour'), type: 'select' },
					{ name: 'set', label: text('Set'), type: 'select' },
					{ name: 'slot', label: text('Slot'), type: 'select' },
				],
				submitLabel: text('Smelt them'),
				confirm: text('Smelt every stored piece that matches? They are gone for good.'),
				async prepare(api, params) {
					const s = params.settlement ? await settlements.get(api, params.settlement) : null;
					if (!s || s.ownerId !== api.playerId) return false;
					const loose = (await loadMine(api, api.playerId)).filter((p) => !p.hero && p.settlement === s.id);
					if (!loose.length) return false;
					const any = { value: '', label: text('Any') };
					const choices = facetChoices(loose);
					const tally: TallyData = {
						items: loose.map((p) => ({ match: facets(p), amounts: smeltValue(api, p) })),
						fields: ['rarity', 'set', 'slot'],
						icons: Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id])),
						summary: text('{0} pieces: {1}'),
						empty: text('None stored here matches.'),
					};
					return {
						defaults: { settlement: s.id },
						options: { rarity: [any, ...choices.rarity], set: [any, ...choices.set], slot: [any, ...choices.slot] },
						// What the choices pick, counted by the client as they change (the pieces sent once, with the form).
						fields: [{ name: 'tally', label: text('Picked'), type: 'widget', widget: 'ui.tally', data: tally }],
					};
				},
			},
			parse: shape({
				settlement: fields.id(),
				rarity: fields.optional(fields.id()),
				set: fields.optional(fields.id()),
				slot: fields.optional(fields.id()),
			}),
			async execute(api, { settlement, rarity, set, slot }) {
				const s = await settlements.requireOwned(api, settlement);
				const mine = await loadMine(api, api.playerId);
				const hit = mine.filter((p) => {
					const f = facets(p);
					return (
						!p.hero && p.settlement === s.id && (!rarity || f.rarity === rarity) && (!set || f.set === set) && (!slot || f.slot === slot)
					);
				});
				if (!hit.length) throw fail('blocked', 'None stored here matches');
				const total: Cost = {};
				for (const p of hit) for (const [r, n] of Object.entries(smeltValue(api, p))) if (n > 0) total[r] = (total[r] ?? 0) + n;
				for (const [r, n] of Object.entries(total)) await resources.add(api, settlements.entity(s.id), r, n);
				const gone = new Set(hit.map((p) => p.id));
				mine.splice(0, mine.length, ...mine.filter((p) => !gone.has(p.id)));
				moved();
				const ids = [...gone];
				for (const chunk of chunks(ids)) {
					api.write(api.db.prepare(`DELETE FROM equipment_items WHERE id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk));
				}
			},
		});

		// The selected settlement's gear as data (AGENTS.md: the server sends data, the browser assembles the rows
		// `equipment.gear`): what the chosen hero (client param `hero`, default the first attached here) wears, how many
		// accessories it may wear, and what the settlement stores with what dismantling each gives. Only heroes attached
		// to it can take stored pieces.
		/** `equipment.items` from the settlement's heroes and the player's pieces: one assembly for the compute and the flat form. */
		const itemsOf = (rules: RuleView, settlementId: string, here: Hero[], pieces: Piece[], capacity: number): EquipmentItems => {
			const ids = new Set(here.map((h) => h.id));
			return {
				settlement: settlementId,
				heroes: here.map((h) => ({
					id: h.id,
					surname: h.surname,
					given: h.given,
					level: h.level,
					gender: h.gender,
					accessories: groupLimits.get('accessory')?.(rules, h) ?? 0,
				})),
				pieces: pieces
					.filter((p) => (p.hero ? ids.has(p.hero) : p.settlement === settlementId))
					.map((p) => ({ id: p.id, base: p.base, rarity: p.rarity, stats: p.stats, hero: p.hero })),
				capacity,
			};
		};
		/** A settlement's storage, kept as the owner's derived value (buildings and research change it; pieces do not). */
		const capacityKept = async (api: EngineApi, s: { id: string; ownerId: string | null }) => {
			const due = await timeline.due(api, settlements.entity(s.id));
			return derive(api, CAPACITY.key(s.id), { owner: s.ownerId, salt: CAPACITY.salt(due), ignore: [...TIMELINE] }, () =>
				capacityOf(api, s.id),
			);
		};

		// A settlement's gear as its rows (AGENTS.md: the server forwards data; the browser assembles `equipment.state`,
		// its names, numbers and dismantling yields, from meta `equipment` and the static `equipment.smelt`): wearing and
		// dismantling are frequent, so nothing worked out from the pieces is stored.
		ctx.views.add({
			id: 'equipment.items',
			// Gear changes with the player's commands and adventures (events on the heroes' home settlement).
			quiet: true,
			async compute(api, params): Promise<EquipmentItems | null> {
				const s = await settlements.resolve(api, params);
				if (!s) return null;
				const capacity = s.ownerId === api.playerId ? await capacityKept(api, s) : await capacityOf(api, s.id);
				const here = (await heroes.list(api, api.playerId)).filter((h) => h.home === s.id);
				return itemsOf(api, s.id, here, await loadMine(api, api.playerId), capacity);
			},
			flat: {
				derived: (f, params) => (params.settlement ? [CAPACITY.wanted(params.settlement)] : []),
				reads: (f, params): Record<string, D1PreparedStatement> =>
					params.settlement
						? {
								row: settlements.flatReads(f, params.settlement).row,
								heroes: heroes.flat.reads(f, f.playerId),
								pieces: f.db.prepare('SELECT * FROM equipment_items WHERE player_id = ? ORDER BY created_at').bind(f.playerId),
							}
						: {},
				build({ payload: params, rows, derived, playerId, ...f }) {
					if (!params.settlement || (rows.row?.[0] as { owner_id?: string } | undefined)?.owner_id !== playerId) return undefined;
					const all = heroes.flat.heroes(rows.heroes);
					const ids = new Set(all.map((h) => h.id));
					const pieces = (rows.pieces as unknown as Row[]).map(toPiece);
					// A piece worn by a dismissed hero, or from before storage: `loadMine` puts it in the capital (not known here).
					if (pieces.some((p) => (p.hero ? !ids.has(p.hero) : !p.settlement))) return undefined;
					const here = all.filter((h) => h.home === params.settlement);
					return itemsOf(f, params.settlement, here, pieces, derived[CAPACITY.key(params.settlement)] as number);
				},
			},
		});
		// What each of the player's heroes wears, summed by stat (its stored row, as written whenever a piece goes on or
		// off): the hero cards and the realms add it to the attributes and the adventure numbers in the browser.
		ctx.views.add({
			id: 'equipment.totals',
			quiet: true,
			compute: (api): Promise<EquipmentTotals> => loadTotals(api, api.playerId),
			flat: {
				reads: (f) => ({ row: f.db.prepare('SELECT totals FROM equipment_totals WHERE player_id = ?').bind(f.playerId) }),
				build: ({ rows }) =>
					(rows.row[0] as { totals?: string } | undefined)?.totals ? JSON.parse((rows.row[0] as { totals: string }).totals) : {},
			},
		});
		// What dismantling gives, by base and colour: the same for everyone under the same rules.
		ctx.statics.add({
			id: 'equipment.smelt',
			compute({ rules }): EquipmentSmelt {
				const api = rules as unknown as ReadApi;
				const out: EquipmentSmelt = {};
				for (const b of bases.values())
					for (const r of rarities.values()) {
						const piece: Piece = {
							id: '',
							playerId: '',
							base: b.id,
							slot: b.slot,
							tier: b.tier,
							rarity: r.id,
							stats: {},
							hero: null,
							settlement: null,
						};
						const cost = smeltValue(api, piece);
						if (Object.keys(cost).length) out[`${b.id}|${r.id}`] = cost;
					}
				return out;
			},
		});
		ctx.meta.add('equipment', () => ({
			slots: service.slots(),
			rarities: service.rarities(),
			bases: [...bases.values()].map((b) => ({
				id: b.id,
				name: b.name,
				slot: b.slot,
				...(b.icon ? { icon: b.icon } : {}),
				...(b.minLevel ? { minLevel: b.minLevel } : {}),
				...(b.set ? { set: { id: b.set.id, name: b.set.name } } : {}),
				// Its stats are named by the plugin defining it: "<that plugin>.stat:<key>".
				labels: statLabels.get(b.id)!('stat:'),
			})),
			// Buildings that store gear (e.g. the armory): their entries show the settlement's equipment.
			storageBuildings: ctx.services
				.get('buildings')
				.list()
				.filter((b) => b.stats?.['equipment.storage'])
				.map((b) => b.id),
		}));

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		// The heroes page: a paper doll (client widget `equipment.doll`, art from a content plugin).
		ui.block({ page: 'heroes', column: 'right', widget: 'equipment.doll', order: 5, props: { view: 'equipment.doll' } });
		// Bulk smelting: its form on an entry of its own (opened from the storage list).
		ui.entry({ kind: 'equipment-smelt', widget: 'forms.entry' });
		// Buildings that store gear (the armory) show the same on their entry.
		ui.entry({
			kind: 'building',
			widget: 'ui.rows',
			order: -40,
			props: { view: 'equipment.gear' },
			types: () =>
				ctx.services
					.get('buildings')
					.list()
					.filter((b) => b.stats?.['equipment.storage'])
					.map((b) => b.id),
		});
	},
});
