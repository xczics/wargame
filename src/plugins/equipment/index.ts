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
import { csvRules, definePlugin, type EngineApi, fields, gameErrors, numberInRange, PluginError, type ReadApi, shape } from '../../kernel';
import type { EquipmentBag, EquipmentPiece, EquipmentState } from '../../shared/api';
import type { TallyData } from '../../shared/ui';
import type { Hero } from '../heroes';
import type { Cost } from '../resources';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, literal, uiTexts } from '../../shared/i18n';

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
		/** Put a piece on a hero or into a settlement's storage. */
		const place = (api: EngineApi, piece: Piece, at: { hero: string } | { settlement: string }) => {
			piece.hero = 'hero' in at ? at.hero : null;
			piece.settlement = 'settlement' in at ? at.settlement : null;
			api.write(
				api.db
					.prepare('UPDATE equipment_items SET hero_id = ?, settlement_id = ? WHERE id = ?')
					.bind(piece.hero, piece.settlement, piece.id),
			);
			const owner = piece.playerId;
			api.beforeCommit(
				`equipment:totals:${owner}`,
				async () => {
					const totals = totalsFrom(await loadMine(api, owner));
					api.write(
						api.db
							.prepare(
								'INSERT INTO equipment_totals (player_id, totals) VALUES (?, ?) ON CONFLICT (player_id) DO UPDATE SET totals = excluded.totals',
							)
							.bind(owner, JSON.stringify(totals)),
					);
				},
				{ writes: ['equipment_totals'] },
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
				const totals = mine ? totalsFrom(await mine) : await loadTotals(api, owner);
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

		ctx.commands.add<{ piece: string; hero: string }>({
			type: 'equipment.equip',
			description:
				'Put a piece on a hero: from the storage of its settlement, or from another hero of the same settlement. What it wore in that slot is stored there. Payload: { "piece", "hero" }',
			parse: shape({ piece: fields.id(), hero: fields.id() }),
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
				const ids = [...gone];
				for (let i = 0; i < ids.length; i += 90) {
					const chunk = ids.slice(i, i + 90);
					api.write(api.db.prepare(`DELETE FROM equipment_items WHERE id IN (${chunk.map(() => '?').join(', ')})`).bind(...chunk));
				}
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
		// The selected settlement's gear as data (AGENTS.md: the server sends data, the browser assembles the rows
		// `equipment.gear`): what the chosen hero (client param `hero`, default the first attached here) wears, how many
		// accessories it may wear, and what the settlement stores with what dismantling each gives. Only heroes attached
		// to it can take stored pieces.
		ctx.views.add({
			id: 'equipment.state',
			// Gear changes with the player's commands and adventures (events on the heroes' home settlement).
			stamp: (api, params) => settlements.stamp(api, params),
			async compute(api, params): Promise<EquipmentState | null> {
				const s = await settlements.resolve(api, params);
				if (!s) return null;
				const mine = await loadMine(api, api.playerId);
				const here = (await heroes.list(api, api.playerId)).filter((h) => h.home === s.id);
				const hero = here.find((h) => h.id === params.hero) ?? here[0];
				const icon = new Map(resources.list().map((r) => [r.id, r.icon ?? r.id]));
				const attrNames = new Map(heroes.attributes().map((a) => [a.id, a.name]));
				const piece = (p: Piece): EquipmentState['pieces'][number] => {
					const b = bases.get(p.base);
					return {
						id: p.id,
						name: b?.name ?? p.base,
						...(b?.icon ? { icon: b.icon } : {}),
						slot: p.slot,
						rarity: p.rarity,
						stats: Object.entries(p.stats).map(([k, value]) => ({
							name: k.startsWith('attr.') ? (attrNames.get(k.slice(5)) ?? k) : (statLabels.get(p.base)?.(`stat:${k}`) ?? `stat:${k}`),
							value,
						})),
						hero: p.hero,
						...(b?.minLevel ? { minLevel: b.minLevel } : {}),
						...(b?.set ? { set: { id: b.set.id, name: b.set.name } } : {}),
					};
				};
				const loose = mine.filter((p) => !p.hero && p.settlement === s.id);
				const smelt: EquipmentState['smelt'] = {};
				const icons: Record<string, string> = {};
				for (const p of loose) {
					smelt[p.id] = smeltValue(api, p);
					for (const r of Object.keys(smelt[p.id])) icons[r] = icon.get(r) ?? r;
				}
				return {
					settlement: s.id,
					heroes: here.map((h) => ({ id: h.id, surname: h.surname, given: h.given, level: h.level })),
					hero: hero?.id ?? null,
					accessories: hero ? (groupLimits.get('accessory')?.(api, hero) ?? 0) : 0,
					slots: service.slots().map((x) => ({ id: x.id, name: x.name, ...(x.group ? { group: x.group } : {}) })),
					rarities: service.rarities().map((r) => ({ id: r.id, name: r.name })),
					pieces: [...(hero ? mine.filter((p) => p.hero === hero.id) : []), ...loose].map(piece),
					storage: { used: await stored(api, api.playerId, s.id), capacity: await capacityOf(api, s.id) },
					smelt,
					icons,
				};
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
		ui.block({ page: 'heroes', column: 'right', widget: 'ui.rows', order: 5, props: { view: 'equipment.gear' } });
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
