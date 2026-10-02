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
import { csvRules, definePlugin, GameError, numberInRange, PluginError, type EngineApi, type ReadApi } from '../../kernel';
import type { EquipmentBag, EquipmentPiece } from '../../shared/api';
import type { Hero } from '../heroes';
import type { Cost } from '../resources';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

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
	/** The pieces a hero wears. */
	worn(api: ReadApi, heroId: string): Promise<Piece[]>;
	/** What smelting a piece gives (content decides; default nothing). */
	setSmeltValue(value: (api: ReadApi, piece: Piece) => Cost): void;
	/** How many slots of `group` a hero may fill (default 0). */
	setGroupLimit(group: string, limit: (api: ReadApi, hero: Hero) => number): void;
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
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const heroes = ctx.services.get('heroes');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const slots = new Map<string, SlotDef>();
		const bases = new Map<string, BaseDef>();
		const rarities = new Map<string, RarityDef>();
		let smeltValue = (_api: ReadApi, _p: Piece): Cost => ({});
		const groupLimits = new Map<string, (api: ReadApi, hero: Hero) => number>();

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
			api.memo(`equipment:mine:${playerId}`, async () => {
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
			});
		/** Put a piece on a hero or into a settlement's storage. */
		const place = (api: EngineApi, piece: Piece, at: { hero: string } | { settlement: string }) => {
			piece.hero = 'hero' in at ? at.hero : null;
			piece.settlement = 'settlement' in at ? at.settlement : null;
			api.write(
				api.db
					.prepare('UPDATE equipment_items SET hero_id = ?, settlement_id = ? WHERE id = ?')
					.bind(piece.hero, piece.settlement, piece.id),
			);
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

		const service: EquipmentService = {
			defineSlot(def) {
				if (slots.has(def.id)) throw new PluginError(`Equipment slot "${def.id}" defined twice`);
				slots.set(def.id, def);
			},
			defineBase(def) {
				if (bases.has(def.id)) throw new PluginError(`Equipment base "${def.id}" defined twice`);
				if (!slots.has(def.slot)) throw new PluginError(`Equipment base "${def.id}": unknown slot "${def.slot}"`);
				bases.set(def.id, def);
			},
			defineRarity(def) {
				if (rarities.has(def.id)) throw new PluginError(`Equipment rarity "${def.id}" defined twice`);
				rarities.set(def.id, def);
			},
			bases: () => [...bases.values()],
			rarities: () => [...rarities.values()].sort((a, b) => a.order - b.order),
			slots: () => [...slots.values()],
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
			setSmeltValue: (v) => void (smeltValue = v),
			setGroupLimit: (group, limit) => void groupLimits.set(group, limit),
		};
		ctx.services.provide('equipment', service);

		// "attr.<attribute>" stats add to the wearer's attributes.
		heroes.addAttributeBonus(async (api, hero) => {
			const out: Record<string, number> = {};
			for (const p of await service.worn(api, hero.id))
				for (const [k, v] of Object.entries(p.stats)) if (k.startsWith('attr.')) out[k.slice(5)] = (out[k.slice(5)] ?? 0) + v;
			return out;
		});

		const owned = async (api: EngineApi, id: string) => {
			const piece = (await loadMine(api, api.playerId)).find((p) => p.id === id);
			if (!piece) throw new GameError('not_found', 'No such piece', 404);
			return piece;
		};
		/** Only heroes at home on a duty they can leave at will may change what they wear. */
		const changeable = async (api: EngineApi, heroId: string) => {
			const hero = (await heroes.list(api, api.playerId)).find((h) => h.id === heroId);
			if (!hero) throw new GameError('not_found', 'No such hero', 404);
			if (!heroes.duty(hero.duty).manual) throw new GameError('blocked', 'The hero is busy');
			await heroes.attributesChanging(api, hero.id);
			return hero;
		};
		const parseId = (raw: unknown, key: string) => {
			const v = (raw as Record<string, unknown> | null)?.[key];
			if (typeof v !== 'string' || !v) throw new GameError('bad_payload', `${key} is required`);
			return v;
		};
		const full = () => new GameError('storage_full', 'No room to store it here (an armory stores more)');

		ctx.commands.add<{ piece: string; hero: string }>({
			type: 'equipment.equip',
			description:
				'Put a piece on a hero: from the storage of its settlement, or from another hero of the same settlement. What it wore in that slot is stored there. Payload: { "piece", "hero" }',
			parse: (raw) => ({ piece: parseId(raw, 'piece'), hero: parseId(raw, 'hero') }),
			async execute(api, { piece: pieceId, hero: heroId }) {
				const piece = await owned(api, pieceId);
				if (piece.hero === heroId) return;
				const hero = await changeable(api, heroId);
				const from = piece.hero ? await changeable(api, piece.hero) : null;
				if ((from ? from.home : piece.settlement) !== hero.home)
					throw new GameError('blocked', 'Only heroes of the settlement where it is can take it');
				const old = (await loadMine(api, api.playerId)).find((p) => p.hero === hero.id && p.slot === piece.slot);
				const group = slots.get(piece.slot)?.group;
				if (group && !old) {
					const limit = groupLimits.get(group)?.(api, hero) ?? 0;
					const worn = (await loadMine(api, api.playerId)).filter((p) => p.hero === hero.id && slots.get(p.slot)?.group === group).length;
					if (worn >= limit)
						throw new GameError('blocked', limit ? `This hero wears at most ${limit} of these` : 'This hero cannot wear these');
				}
				// From storage, the old piece takes its place; from another hero, it needs room.
				if (old && from && (await room(api, api.playerId, hero.home)) <= 0) throw full();
				const base = bases.get(piece.base);
				if (base?.minLevel && hero.level < base.minLevel) throw new GameError('blocked', `Needs a hero of level ${base.minLevel}`);
				// Off first: the unique index (hero, slot) is checked statement by statement.
				if (old) place(api, old, { settlement: hero.home });
				place(api, piece, { hero: hero.id });
			},
		});
		ctx.commands.add<{ piece: string }>({
			type: 'equipment.unequip',
			description: 'Take a piece off its hero and store it in the hero\'s settlement. Payload: { "piece" }',
			parse: (raw) => ({ piece: parseId(raw, 'piece') }),
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
			parse: (raw) => ({ piece: parseId(raw, 'piece') }),
			async execute(api, { piece: pieceId }) {
				const piece = await owned(api, pieceId);
				if (piece.hero || !piece.settlement) throw new GameError('blocked', 'Take it off first');
				const s = await settlements.requireOwned(api, piece.settlement);
				for (const [r, n] of Object.entries(smeltValue(api, piece))) if (n > 0) await resources.add(api, settlements.entity(s.id), r, n);
				const mine = await loadMine(api, api.playerId);
				mine.splice(mine.indexOf(piece), 1);
				api.write(api.db.prepare('DELETE FROM equipment_items WHERE id = ?').bind(piece.id));
			},
		});

		ctx.views.add({
			id: 'equipment.bag',
			async compute(api): Promise<EquipmentBag> {
				const mine = await loadMine(api, api.playerId);
				const pieces: EquipmentPiece[] = mine.map((p) => {
					const b = bases.get(p.base);
					return {
						id: p.id,
						base: p.base,
						name: b?.name ?? p.base,
						...(b?.icon ? { icon: b.icon } : {}),
						slot: p.slot,
						tier: p.tier,
						rarity: p.rarity,
						stats: p.stats,
						hero: p.hero,
						settlement: p.settlement,
						...(b?.minLevel ? { minLevel: b.minLevel } : {}),
						...(b?.set ? { set: b.set.name } : {}),
					};
				});
				const storage: EquipmentBag['storage'] = {};
				for (const s of await settlements.mine(api, api.playerId))
					storage[s.id] = {
						used: await stored(api, api.playerId, s.id),
						capacity: await capacityOf(api, s.id),
					};
				const groups: EquipmentBag['groups'] = {};
				for (const h of await heroes.list(api, api.playerId))
					for (const [g, limit] of groupLimits) (groups[h.id] ??= {})[g] = limit(api, h);
				return { storage, pieces, groups, smelt: Object.fromEntries(mine.map((p) => [p.id, smeltValue(api, p)])) };
			},
		});
		ctx.meta.add('equipment', () => ({
			slots: service.slots(),
			rarities: service.rarities(),
			// Buildings that store gear (e.g. the armory): their entries show the settlement's equipment.
			storageBuildings: ctx.services
				.get('buildings')
				.list()
				.filter((b) => b.stats?.['equipment.storage'])
				.map((b) => b.id),
		}));

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.block({ page: 'heroes', column: 'right', widget: 'equipment.block', order: 5 });
		// Buildings that store gear (the armory) show the same on their entry.
		ui.entry({
			kind: 'building',
			widget: 'equipment.block',
			order: -40,
			types: () =>
				ctx.services
					.get('buildings')
					.list()
					.filter((b) => b.stats?.['equipment.storage'])
					.map((b) => b.id),
		});
	},
});
