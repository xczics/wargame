/**
 * Default equipment content (docs/design/gameplay.md §10), all numbers in ./data (CSV): five regular
 * slots and twelve accessory kinds, seven regular sets (every piece with its own minimum level and
 * realms) and four accessory sets, five colours of rarity, the accessories a woman hero may wear,
 * and the armory. It also connects equipment to the rest:
 *   - realms: equipment in every realm's reward pool, one entry per set and colour (accessories
 *     per colour), worn pieces add to the hero's adventure numbers ("adv.*"); a realm shop sells
 *     white pieces of the realms a player has opened;
 *   - battle: "battle.attack / battle.defense" are flat bonuses in every lane while the wearer leads or defends;
 *   - dismantling gives back some resources.
 */
import {
	csvMap,
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	type EngineApi,
	fields,
	gameErrors,
	numberFields,
	PluginError,
	type ReadApi,
	seededRandom,
	shape,
} from '../../kernel';
import { amounts } from '../../shared/format';
import type { RowsData, UiRow } from '../../shared/ui';
import type { RealmShop } from '../../shared/api';
import type { AdventureStats } from '../../shared/realms';
import type { Hero } from '../heroes';
import type { RealmDef } from '../realms';
import accessoriesCsv from './data/accessories.csv?raw';
import buildingsCsv from './data/buildings.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import piecesCsv from './data/pieces.csv?raw';
import raritiesCsv from './data/rarities.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import setsCsv from './data/sets.csv?raw';
import slotsCsv from './data/slots.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, uiTexts } from '../../shared/i18n';

const fail = gameErrors('starter-equipment');
const text = uiTexts('starter-equipment');

const RULES = csvRules(rulesCsv);
const SLOTS = csvRows(slotsCsv).map((r) => ({
	id: r.id,
	name: r.name,
	group: r.group || undefined,
	icon: r.icon || undefined,
	stats: csvMap(r.stats),
}));
const SETS = csvRows(setsCsv).map((r) => ({
	id: r.id,
	name: r.name,
	kind: r.kind as 'regular' | 'accessory',
	order: csvNumber(r, 'order'),
	scale: csvNumber(r, 'scale'),
	recovery: csvNumber(r, 'recovery'),
	attrs: csvNumber(r, 'attrs'),
	from: r.from ? csvNumber(r, 'from') : 0,
	to: r.to ? csvNumber(r, 'to') : 0,
	minLevel: r.minLevel ? csvNumber(r, 'minLevel') : 0,
}));
const SET = new Map(SETS.map((x) => [x.id, x]));
const SLOT = new Map(SLOTS.map((x) => [x.id, x]));
interface Piece {
	id: string;
	name: string;
	set: string;
	slot: string;
	icon?: string;
	minLevel: number;
	from: number;
	to: number;
}
const PIECES: Piece[] = csvRows(piecesCsv).map((r) => ({
	id: r.id,
	name: r.name,
	set: r.set,
	slot: r.slot,
	icon: r.icon || undefined,
	minLevel: csvNumber(r, 'minLevel'),
	from: csvNumber(r, 'from'),
	to: csvNumber(r, 'to'),
}));
// Accessories: one piece per accessory set and kind, named after the kind (the set shows beside it).
for (const set of SETS.filter((x) => x.kind === 'accessory'))
	for (const slot of SLOTS.filter((x) => x.group === 'accessory'))
		PIECES.push({
			id: `${set.id}-${slot.id}`,
			name: slot.name,
			set: set.id,
			slot: slot.id,
			icon: slot.icon,
			minLevel: set.minLevel,
			from: set.from,
			to: set.to,
		});
for (const p of PIECES)
	if (!SET.has(p.set) || !SLOT.has(p.slot)) throw new PluginError(`starter-equipment: piece "${p.id}" has an unknown set or slot`);
const RARITIES = csvRows(raritiesCsv).map((r) => ({
	id: r.id,
	name: r.name,
	order: csvNumber(r, 'order'),
	mult: csvNumber(r, 'mult'),
	attrs: csvNumber(r, 'attrs'),
	early: csvNumber(r, 'early'),
	late: csvNumber(r, 'late'),
	accessory: csvNumber(r, 'accessory') > 0,
}));
const ACCESSORY_SLOTS = csvRows(accessoriesCsv)
	.map((r) => ({ talent: csvNumber(r, 'talent'), slots: csvNumber(r, 'slots') }))
	.sort((a, b) => a.talent - b.talent);
/** Recovery and percentages keep a decimal; the rest is whole. */
const round = (key: string, v: number) => (key === 'adv.recovery' ? Math.round(v * 10) / 10 : Math.round(v));
/** A colour's weight in a realm: from `early` (realm 1) to `late` (realm 10) in a straight line. */
const colourWeight = (r: (typeof RARITIES)[number], order: number) =>
	r.early + ((r.late - r.early) * Math.min(9, Math.max(0, order - 1))) / 9;
const inRealm = (p: Piece, realm: RealmDef) => p.from <= realm.order && realm.order <= p.to;

export default definePlugin({
	id: 'starter-equipment',
	version: '0.2.0',
	description: 'Seven equipment sets and four accessory sets in five colours; drops, realm shop, adventure and battle bonuses, armory',
	dependsOn: ['equipment', 'heroes', 'realms', 'battle', 'stats', 'settlements', 'buildings', 'resources', 'items', 'ui', 'i18n'],
	setup(ctx) {
		// Texts shown in this plugin's own views (names from its tables) are its i18n keys.
		const own = ctx.services.get('i18n').scope();
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const equipment = ctx.services.get('equipment');
		const heroes = ctx.services.get('heroes');
		const realms = ctx.services.get('realms');
		const stats = ctx.services.get('stats');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		ctx.services.get('buildings').defineFromCsv(buildingsCsv, levelsCsv);
		for (const s of SLOTS) equipment.defineSlot({ id: s.id, name: s.name, icon: s.icon, group: s.group });
		for (const p of PIECES) {
			const set = SET.get(p.set)!;
			equipment.defineBase({
				id: p.id,
				name: p.name,
				slot: p.slot,
				tier: set.order,
				icon: p.icon,
				minLevel: p.minLevel,
				set: { id: set.id, name: set.name },
			});
		}
		for (const r of RARITIES) equipment.defineRarity({ id: r.id, name: `rarity:${r.id}`, order: r.order });

		const rules = ctx.config.define('rules', {
			description:
				'drop.weight / drop.accessory in realm pools, drop.variance of rolled stats, smelt.total x set scale x colour multiplier split by smelt.<resource>, shop.price x set scale.',
			default: () => RULES as Record<string, Record<string, number>>,
			parse(raw) {
				const r = (raw ?? {}) as Record<string, unknown>;
				const part = (k: string) => numberFields(() => RULES[k] as Record<string, number>, 0, 1e9)(r[k] ?? {});
				return { drop: part('drop'), smelt: part('smelt'), shop: part('shop') };
			},
		});
		const rule = (api: ReadApi) => rules.get(api) as Record<'drop' | 'smelt' | 'shop', Record<string, number>>;
		const RARITY = new Map(RARITIES.map((r) => [r.id, r]));
		const PIECE = new Map(PIECES.map((p) => [p.id, p]));

		// Dismantling: some resources back, by set and colour.
		equipment.setSmeltValue((api, p) => {
			const sm = rule(api).smelt;
			const set = SET.get(PIECE.get(p.base)?.set ?? '');
			const total = sm.total * (set?.scale ?? p.tier) * (RARITY.get(p.rarity)?.mult ?? 1);
			return Object.fromEntries(
				Object.entries(sm)
					.filter(([k]) => k !== 'total')
					.map(([res, share]) => [res, Math.round(total * share)])
					.filter(([, n]) => (n as number) > 0),
			);
		});

		// Women heroes wear accessories, as many as their talent allows (fixed at recruitment).
		equipment.setGroupLimit('accessory', (_api, hero) => {
			if (hero.gender !== 'f') return 0;
			let n = 0;
			for (const row of ACCESSORY_SLOTS) if (hero.talent >= row.talent) n = row.slots;
			return n;
		});

		/** A new piece's stats: base x set scale x colour, +-variance; six-attribute points of the colour, spread at random. */
		function roll(api: ReadApi, piece: Piece, rarity: (typeof RARITIES)[number], random: () => number) {
			const set = SET.get(piece.set)!;
			const variance = rule(api).drop.variance;
			const out: Record<string, number> = {};
			for (const [k, v] of Object.entries(SLOT.get(piece.slot)!.stats))
				out[k] = round(k, v * (k === 'adv.recovery' ? set.recovery : set.scale) * rarity.mult * (1 - variance + 2 * variance * random()));
			const attrs = heroes.attributes();
			const points = Math.round(rarity.attrs * set.attrs);
			const accessory = SLOT.get(piece.slot)!.group === 'accessory';
			for (let i = 0; i < points && attrs.length; i++) {
				// Accessories always give some charm.
				const a = accessory && i === 0 && attrs.some((x) => x.id === 'charm') ? 'charm' : attrs[Math.floor(random() * attrs.length)].id;
				out[`attr.${a}`] = (out[`attr.${a}`] ?? 0) + 1;
			}
			return out;
		}

		/* ----- drops in realms ------------------------------------------------------------- */

		const regular = PIECES.filter((p) => SET.get(p.set)!.kind === 'regular');
		const accessories = PIECES.filter((p) => SET.get(p.set)!.kind === 'accessory');
		/** Share of a colour among the colours that can drop (accessories: no white). */
		const colourShare = (rarity: (typeof RARITIES)[number], realm: RealmDef, forAccessory: boolean) => {
			const all = RARITIES.filter((r) => !forAccessory || r.accessory);
			const total = all.reduce((a, r) => a + colourWeight(r, realm.order), 0);
			return total ? colourWeight(rarity, realm.order) / total : 0;
		};
		async function give(
			api: EngineApi,
			playerId: string,
			home: string,
			piece: Piece,
			rarity: (typeof RARITIES)[number],
			random: () => number,
		) {
			const made = await equipment.create(api, playerId, home, {
				base: piece.id,
				rarity: rarity.id,
				stats: roll(api, piece, rarity, random),
			});
			return [{ kind: 'equipment', name: piece.name, icon: piece.icon, rarity: rarity.id, ...(made ? {} : { lost: true }) }];
		}
		// One drop per piece and colour (user 2026-10-05: "白色靴子和白色盔甲要单独算两个掉落格子"; "要分开指定"): the GM weighs
		// each on its own (realms.pools). Players see them merged by set and colour ("gold Azure Edge set"): the
		// previews are alike, and the drop list adds alike ones up. By default a set's share is split evenly among
		// its pieces dropping in the realm, as before.
		for (const piece of regular)
			for (const rarity of RARITIES)
				realms.addDrop({
					id: `starter-equipment.${piece.id}.${rarity.id}`,
					weight: (realm, _task, api) => {
						if (!inRealm(piece, realm)) return 0;
						const here = regular.filter((p) => inRealm(p, realm)).length;
						return here ? (rules.get(api).drop.weight / here) * colourShare(rarity, realm, false) : 0;
					},
					preview: { kind: 'equipment', name: SET.get(piece.set)!.name, icon: '🎁', rarity: rarity.id },
					label: text('{0} {1}', { 0: text(`rarity:${rarity.id}`), 1: text(piece.name) }),
					give: (api, c) => give(api, c.playerId, c.hero.home, piece, rarity, c.random),
				});
		// Accessories alike: one per piece and colour, shown as just "accessory".
		for (const piece of accessories)
			for (const rarity of RARITIES.filter((r) => r.accessory))
				realms.addDrop({
					id: `starter-equipment.${piece.id}.${rarity.id}`,
					weight: (realm, _task, api) => {
						if (!inRealm(piece, realm)) return 0;
						const here = accessories.filter((p) => inRealm(p, realm)).length;
						return here ? (rules.get(api).drop.accessory / here) * colourShare(rarity, realm, true) : 0;
					},
					preview: { kind: 'equipment', name: 'Accessory', icon: '💍', rarity: rarity.id },
					label: text('{0} {1}', { 0: text(`rarity:${rarity.id}`), 1: text(piece.name) }),
					give: (api, c) => give(api, c.playerId, c.hero.home, piece, rarity, c.random),
				});

		/* ----- chests: "<colour> <set> chest", a random piece of that set in that colour ------------- */

		// One item per set and colour, but no white (white regular pieces are sold in the realm shop; accessories
		// never come in white): sold in the shop (starter-shop), or given by the GM. It
		// opens into the selected settlement's storage; with no room there it is refused and kept.
		const items = ctx.services.get('items');
		for (const set of SETS)
			for (const rarity of RARITIES.filter((r) => r.accessory)) {
				const pieces = PIECES.filter((p) => p.set === set.id);
				items.define<{ settlement: string }>({
					id: `chest-${set.id}-${rarity.id}`,
					// "金色青锋套装宝箱"; accessory sets by their short name, "绿色素心饰品宝箱".
					name: ctx.services
						.get('i18n')
						.derive(
							`item:chest-${set.id}-${rarity.id}`,
							set.kind === 'accessory'
								? text('{0} {1} accessory chest', { 0: text(`rarity:${rarity.id}`), 1: text(`chest-set:${set.id}`) })
								: text('{0} {1} chest', { 0: text(`rarity:${rarity.id}`), 1: text(set.name) }),
						),
					icon: '🎁',
					rarity: rarity.id,
					category: 'chests',
					description: 'Opens into a random piece of this set in this colour, kept in the selected settlement.',
					use: {
						parse: shape({ settlement: fields.id() }),
						async apply(api, { settlement }) {
							const s = await settlements.requireOwned(api, settlement);
							// Seeded by player and time: a retried command opens the same piece.
							const random = seededRandom(`chest:${api.playerId}:${api.now}:${set.id}:${rarity.id}`);
							const piece = pieces[Math.floor(random() * pieces.length)];
							await equipment.createOrRefuse(api, api.playerId, s.id, {
								base: piece.id,
								rarity: rarity.id,
								stats: roll(api, piece, rarity, random),
							});
						},
						form: {
							title: text('Open the chest'),
							fields: [{ name: 'settlement', label: text('settlement'), type: 'hidden' }],
							submitLabel: text('Open'),
							async prepare(api, params) {
								const s = await settlements.resolve(api, params);
								return s ? { defaults: { settlement: s.id } } : false;
							},
						},
					},
				});
			}

		/* ----- the realm shop: white regular pieces of the realms a player has opened ----------- */

		const white = RARITIES[0];
		async function offers(api: ReadApi, playerId: string, realm?: { order: number }) {
			const open = new Set<number>();
			for (const r of realms.list()) if (await realms.isUnlocked(api, playerId, r.id)) open.add(r.order);
			const price = rule(api).shop.price;
			return regular
				.filter((p) => [...open].some((o) => p.from <= o && o <= p.to && (!realm || o === realm.order)))
				.map((p) => ({ piece: p, cost: { gold: Math.round(price * SET.get(p.set)!.scale) } }));
		}
		ctx.views.add({
			id: 'starter-equipment.shop',
			async compute(api): Promise<RealmShop> {
				return {
					offers: (await offers(api, api.playerId)).map(({ piece, cost }) => ({
						base: piece.id,
						name: own(piece.name),
						icon: piece.icon,
						slot: piece.slot,
						set: own(SET.get(piece.set)!.name),
						minLevel: piece.minLevel,
						cost,
					})),
				};
			},
		});
		// The realm shop for the generic rows widget (Realms page, left): bought into the selected settlement.
		/*
		 * The realm shop: every realm's white pieces and prices, the static view `starter-equipment.shop-catalog`, baked per
		 * rules version. The browser picks the realm shown (filter "realms.realm"), says whether a price is affordable
		 * (the selected settlement's gold, counted on) and buys into the selected settlement (`withParams`); the
		 * player's view only says which realms are open (user 2026-10-05: "秘境商店明显应该由浏览器负责筛选呀。").
		 */
		ctx.statics.add({
			id: 'starter-equipment.shop-catalog',
			compute({ rules }): RowsData {
				const api = rules as unknown as ReadApi;
				const icons = Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id]));
				const price = rule(api).shop.price;
				return {
					title: text('Realm shop'),
					sections: realms.list().map((r) => ({
						group: r.id,
						title: keyText(r.name),
						rows: regular
							.filter((p) => p.from <= r.order && r.order <= p.to)
							.map((piece): UiRow => {
								const cost = { gold: Math.round(price * SET.get(piece.set)!.scale) };
								return {
									id: piece.id,
									icon: piece.icon,
									title: text(piece.name),
									rarity: 'white',
									lines: [{ text: text('{set} · Lv {n}', { set: text(SET.get(piece.set)!.name), n: piece.minLevel }), tone: 'muted' }],
									// The realm open first, then the gold (the client's counters: open realms, the settlement's stock).
									needs: [
										{ counter: `realm:${r.id}`, amount: 1, short: text('Open this realm to buy its pieces.') },
										...Object.entries(cost).map(([res, n]) => ({
											counter: `resource:${res}`,
											amount: n,
											short: text('Not enough resources'),
										})),
									],
									actions: [
										{
											command: 'starter-equipment.buy',
											payload: { base: piece.id },
											withParams: ['settlement'],
											label: text('{cost}', { cost: amounts(cost, icons) }),
											notice: text('Bought {0}: it is stored in this settlement.', { 0: text(piece.name) }),
											pending: text('Buying {0}…', { 0: text(piece.name) }),
										},
									],
								};
							}),
					})),
					notes: [{ text: text('White pieces of the realms you have opened. Other colours only drop on adventures.'), tone: 'muted' }],
				};
			},
		});
		ctx.views.add({
			id: 'starter-equipment.shop-rows',
			async compute(api): Promise<RowsData | null> {
				const open: { id: string; order: number }[] = [];
				for (const r of realms.list()) if (await realms.isUnlocked(api, api.playerId, r.id)) open.push(r);
				if (!open.length) return null;
				const isOpen = new Set(open.map((r) => r.id));
				return {
					base: 'starter-equipment.shop-catalog',
					// The newest open realm by default (the realms page on the right follows the same choice).
					defaultTab: open.reduce((a, b) => (b.order > a.order ? b : a)).id,
					counters: Object.fromEntries(open.map((r) => [`realm:${r.id}`, 1])),
					sections: realms.list().map((r) => ({
						group: r.id,
						allRows: true,
						rows: [],
						...(isOpen.has(r.id) ? {} : { title: text('{0} 🔒', { 0: keyText(r.name) }) }),
					})),
				};
			},
		});
		ctx.commands.add<{ base: string; settlement?: string }>({
			type: 'starter-equipment.buy',
			description:
				'Buy a white piece in the realm shop (pieces the realms you have opened drop), stored in a settlement (none: the capital). Payload: { "base", "settlement"? }',
			parse: shape({ base: fields.id(), settlement: fields.optional(fields.id()) }),
			async execute(api, { base, settlement }) {
				const s = settlement ? await settlements.requireOwned(api, settlement) : await settlements.capital(api, api.playerId);
				if (!s) throw fail('blocked', 'You have no settlement yet');
				const offer = (await offers(api, api.playerId)).find((o) => o.piece.id === base);
				if (!offer) throw fail('blocked', 'Not for sale (open the realms that drop it)');
				await resources.spend(api, settlements.entity(s.id), offer.cost);
				await equipment.createOrRefuse(api, api.playerId, s.id, {
					base,
					rarity: white.id,
					stats: roll(api, offer.piece, white, seededRandom(crypto.randomUUID())),
				});
			},
		});

		/* ----- what worn pieces do ------------------------------------------------------------ */

		const sum = async (api: ReadApi, hero: Hero, prefix: string) => {
			const out: Record<string, number> = {};
			for (const [k, v] of Object.entries(await equipment.wornStats(api, hero.id)))
				if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
			return out;
		};
		realms.addHeroStats(async (api, hero) => (await sum(api, hero, 'adv.')) as Partial<AdventureStats>);

		// Battle: the heroes leading the army (duty "command") or defending the settlement.
		ctx.services.get('battle').addModifier(async (api, side) => {
			let group: Hero[] = [];
			if (side.role === 'attacker' && side.armyId) group = await heroes.onDuty(api, 'command', side.armyId);
			else if (side.role === 'defender' && side.settlement?.ownerId)
				group = await heroes.defenders(
					api,
					side.settlement.id,
					await stats.get(api, 'heroes.defenders', settlements.entity(side.settlement.id)),
				);
			const total: Record<string, number> = {};
			for (const h of group) for (const [k, v] of Object.entries(await sum(api, h, 'battle.'))) total[k] = (total[k] ?? 0) + v;
			return Object.entries(total)
				.filter(([k, v]) => v && (k === 'attack' || k === 'defense'))
				.map(([k, v]) => ({ source: text('Equipment'), stat: k as 'attack' | 'defense', flat: Math.round(v) }));
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.block({
			page: 'realms',
			column: 'left',
			widget: 'ui.rows',
			order: 30,
			props: { view: 'starter-equipment.shop-rows', filter: 'realms.realm' },
		});
	},
});
