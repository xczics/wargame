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
	GameError,
	numberFields,
	PluginError,
	seededRandom,
	type EngineApi,
	type ReadApi,
} from '../../kernel';
import { amounts } from '../../shared/format';
import type { RowsData } from '../../shared/ui';
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
		ctx.services.get('i18n').addCsv(i18nCsv);
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
		for (const r of RARITIES) equipment.defineRarity({ id: r.id, name: r.name, order: r.order });

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

		const pick = <T>(list: T[], weight: (x: T) => number, random: () => number) => {
			const total = list.reduce((a, x) => a + weight(x), 0);
			let at = random() * total;
			for (const x of list) if ((at -= weight(x)) < 0) return x;
			return list[list.length - 1];
		};
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
		// Regular: one entry per set and colour (shown merged: "gold Azure Edge set"); the piece is any of
		// that set's pieces dropping in this realm. GM: tune with realms.dropWeights like any other drop.
		for (const set of SETS.filter((x) => x.kind === 'regular'))
			for (const rarity of RARITIES)
				realms.addDrop({
					id: `starter-equipment.${set.id}.${rarity.id}`,
					weight: (realm, _task, api) => {
						const here = regular.filter((p) => inRealm(p, realm));
						const mine = here.filter((p) => p.set === set.id).length;
						return here.length ? ((rules.get(api).drop.weight * mine) / here.length) * colourShare(rarity, realm, false) : 0;
					},
					preview: { kind: 'equipment', name: set.name, icon: '🎁', rarity: rarity.id },
					give: (api, c) =>
						give(
							api,
							c.playerId,
							c.hero.home,
							pick(
								regular.filter((p) => p.set === set.id && inRealm(p, c.realm)),
								() => 1,
								c.random,
							),
							rarity,
							c.random,
						),
				});
		// Accessories: one entry per colour (shown as just "accessory"), any kind of a set dropping here.
		for (const rarity of RARITIES.filter((r) => r.accessory))
			realms.addDrop({
				id: `starter-equipment.accessory.${rarity.id}`,
				weight: (realm, _task, api) =>
					accessories.some((p) => inRealm(p, realm)) ? rules.get(api).drop.accessory * colourShare(rarity, realm, true) : 0,
				preview: { kind: 'equipment', name: 'Accessory', icon: '💍', rarity: rarity.id },
				give: (api, c) =>
					give(
						api,
						c.playerId,
						c.hero.home,
						pick(
							accessories.filter((p) => inRealm(p, c.realm)),
							() => 1,
							c.random,
						),
						rarity,
						c.random,
					),
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
					// Translated by pattern: "金色青锋套装宝箱"; accessory sets by their short name, "绿色素心饰品宝箱".
					name:
						set.kind === 'accessory' ? `rarity:${rarity.id} chest-set:${set.id} accessory chest` : `rarity:${rarity.id} ${set.name} chest`,
					icon: '🎁',
					rarity: rarity.id,
					category: 'chests',
					description: 'Opens into a random piece of this set in this colour, kept in the selected settlement.',
					use: {
						parse(raw) {
							const s = (raw as Record<string, unknown> | null)?.settlement;
							if (typeof s !== 'string' || !s) throw new GameError('bad_payload', 'settlement is required');
							return { settlement: s };
						},
						async apply(api, { settlement }) {
							const s = await settlements.requireOwned(api, settlement);
							// Seeded by player and time: a retried command opens the same piece.
							const random = seededRandom(`chest:${api.playerId}:${api.now}:${set.id}:${rarity.id}`);
							const piece = pieces[Math.floor(random() * pieces.length)];
							const made = await equipment.create(api, api.playerId, s.id, {
								base: piece.id,
								rarity: rarity.id,
								stats: roll(api, piece, rarity, random),
							});
							if (!made) throw new GameError('storage_full', 'No room to store it here (an armory stores more)');
						},
						form: {
							title: 'Open the chest',
							fields: [{ name: 'settlement', label: 'settlement', type: 'hidden' }],
							submitLabel: 'Open',
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
						name: piece.name,
						icon: piece.icon,
						slot: piece.slot,
						set: SET.get(piece.set)!.name,
						minLevel: piece.minLevel,
						cost,
					})),
				};
			},
		});
		// The realm shop for the generic rows widget (Realms page, left): bought into the selected settlement.
		ctx.views.add({
			id: 'starter-equipment.shop-rows',
			async compute(api, params): Promise<RowsData | null> {
				const here = await settlements.resolve(api, params);
				const list = await offers(api, api.playerId);
				if (!here || !list.length) return null;
				const icons = Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id]));
				const holder = settlements.entity(here.id);
				// A section per realm (what it drops), following the realm chosen on the right (filter "realms.realm"),
				// the newest open one by default, so the list stays short. A realm not open yet shows its pieces
				// and prices, not for sale until it is.
				const price = rule(api).shop.price;
				const open: { id: string; order: number }[] = [];
				const sections: RowsData['sections'] = [];
				for (const r of realms.list()) {
					const unlocked = await realms.isUnlocked(api, api.playerId, r.id);
					if (unlocked) open.push(r);
					const pieces = regular
						.filter((p) => p.from <= r.order && r.order <= p.to)
						.map((p) => ({ piece: p, cost: { gold: Math.round(price * SET.get(p.set)!.scale) } }));
					sections.push({
						group: r.id,
						title: unlocked ? { text: r.name } : { text: '{0} 🔒', vars: { 0: r.name } },
						...(unlocked ? {} : { intro: [{ text: { text: 'Open this realm to buy its pieces.' }, tone: 'muted' as const }] }),
						rows: await Promise.all(
							pieces.map(async ({ piece, cost }) => ({
								id: piece.id,
								icon: piece.icon,
								title: { text: piece.name },
								rarity: 'white',
								lines: [
									{
										text: { text: '{set} · Lv {n}', vars: { set: SET.get(piece.set)!.name, n: piece.minLevel } },
										tone: 'muted' as const,
									},
								],
								actions: [
									{
										command: 'starter-equipment.buy',
										payload: { base: piece.id, settlement: here.id },
										label: { text: '{cost}', vars: { cost: amounts(cost, icons) } },
										...(!unlocked
											? { blocked: { text: 'Open this realm to buy its pieces.' } }
											: (await resources.canAfford(api, holder, cost))
												? {}
												: { blocked: { text: 'Not enough resources' } }),
									},
								],
							})),
						),
					});
				}
				return {
					title: { text: 'Realm shop' },
					...(open.length ? { defaultTab: open.reduce((a, b) => (b.order > a.order ? b : a)).id } : {}),
					sections,
					notes: [{ text: { text: 'White pieces of the realms you have opened. Other colours only drop on adventures.' }, tone: 'muted' }],
				};
			},
		});
		ctx.commands.add<{ base: string; settlement: string }>({
			type: 'starter-equipment.buy',
			description:
				'Buy a white piece in the realm shop (pieces the realms you have opened drop), stored in a settlement. Payload: { "base", "settlement" }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.base !== 'string' || typeof p.settlement !== 'string')
					throw new GameError('bad_payload', 'base and settlement are required');
				return { base: p.base, settlement: p.settlement };
			},
			async execute(api, { base, settlement }) {
				const s = await settlements.requireOwned(api, settlement);
				const offer = (await offers(api, api.playerId)).find((o) => o.piece.id === base);
				if (!offer) throw new GameError('blocked', 'Not for sale (open the realms that drop it)');
				await resources.spend(api, settlements.entity(s.id), offer.cost);
				const made = await equipment.create(api, api.playerId, s.id, {
					base,
					rarity: white.id,
					stats: roll(api, offer.piece, white, seededRandom(crypto.randomUUID())),
				});
				if (!made) throw new GameError('storage_full', 'No room to store it here (an armory stores more)');
			},
		});

		/* ----- what worn pieces do ------------------------------------------------------------ */

		const sum = async (api: ReadApi, hero: Hero, prefix: string) => {
			const out: Record<string, number> = {};
			for (const p of await equipment.worn(api, hero.id))
				for (const [k, v] of Object.entries(p.stats))
					if (k.startsWith(prefix)) out[k.slice(prefix.length)] = (out[k.slice(prefix.length)] ?? 0) + v;
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
				.map(([k, v]) => ({ source: 'Equipment', stat: k as 'attack' | 'defense', flat: Math.round(v) }));
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
