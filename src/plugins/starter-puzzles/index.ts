/**
 * Puzzles' starter content (docs/design/gameplay.md §13): what completing a puzzle (or a duplicate piece) can bring,
 * wired to the systems that own such things, and where players see their puzzles (the Music House, the Items page).
 * `puzzles` itself knows none of these.
 *
 *   resources   amounts of each resource, into the capital
 *   item        an item
 *   equipment   a piece of a starter set in a colour (one piece, or any of the set), into the capital's storage
 *   troops      units of one kind, into the capital's garrison
 *   hero-female a hero drawn by a recruiting venue's rules, a woman
 *   hero        a hero by the GM's numbers (each attribute; empty ones drawn), of a venue
 *   defense     permanent base defence for every lane of a settlement the player picks (starter-defense), added after
 *               every percentage
 */
import { definePlugin, type EngineApi, fields, GameError, gameErrors, numberInRange, shape } from '../../kernel';
import { amount } from '../../shared/format';
import { keyText, literal, uiTexts } from '../../shared/i18n';
import type { RewardLine } from '../../shared/api';
import type { UiText } from '../../shared/ui';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('starter-puzzles');
const text = uiTexts('starter-puzzles');

export default definePlugin({
	id: 'starter-puzzles',
	version: '0.1.0',
	description: 'Puzzle rewards (resources, items, troops, heroes) and where players see their puzzles',
	dependsOn: ['puzzles', 'resources', 'items', 'troops', 'heroes', 'settlements', 'starter-equipment', 'starter-defense', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const puzzles = ctx.services.get('puzzles');
		const resources = ctx.services.get('resources');
		const items = ctx.services.get('items');
		const troops = ctx.services.get('troops');
		const heroes = ctx.services.get('heroes');
		const settlements = ctx.services.get('settlements');

		/** Rewards go to the capital (a player who has none yet cannot claim: nowhere to put them). */
		const capitalOf = async (api: Parameters<typeof settlements.capital>[0], playerId: string) => {
			const c = await settlements.capital(api, playerId);
			if (!c) throw fail('no_capital', 'Found your capital first');
			return c;
		};
		const count = (max: number) => fields.int(1, max);

		// Where players see their puzzles: a card each on the Items page (group "Puzzles"), the whole board in the Music House.
		const ui = ctx.services.get('ui');
		ui.entry({
			kind: 'building',
			types: ['music-house'],
			widget: 'puzzles.board',
			order: 60,
			props: { view: 'puzzles.mine', catalog: 'puzzles.catalog' },
		});
		items.addCards(async (api) => {
			const mine = await puzzles.progress(api, api.playerId);
			if (!mine.length) return null;
			return {
				group: { id: 'puzzles', label: text('Puzzles') },
				cards: mine.map((p) => ({
					id: `puzzle:${p.id}`,
					icon: '🧩',
					// The tiles show the title only: the progress goes in it.
					title: text('{0} · {1} / {2}', { 0: literal(p.name), 1: p.pieces, 2: p.grid * p.grid }),
					lines: [
						{
							text: text('Collected {0} / {1}', { 0: p.pieces, 1: p.grid * p.grid }),
							tone: p.pieces >= p.grid * p.grid ? ('info' as const) : undefined,
						},
						...(p.limit > 1 || p.claims ? [{ text: text('Claimed {0} / {1}', { 0: p.claims, 1: p.limit }), tone: 'muted' as const }] : []),
					],
					text: text('The whole picture is in the Music House.'),
				})),
			};
		});

		puzzles.addRewardKind<Record<string, number>>({
			id: 'resources',
			name: 'Resources',
			fields: resources.list().map((r) => ({ name: r.id, label: keyText(r.name), type: 'number' as const, min: 0 })),
			parse: (raw) => {
				if (typeof raw !== 'object' || raw === null) throw fail('bad_config', 'Expected { resource: amount }');
				const ids = new Set(resources.list().map((r) => r.id));
				const out: Record<string, number> = {};
				for (const [id, n] of Object.entries(raw)) {
					if (!ids.has(id)) throw fail('bad_config', text('Unknown resource "{0}"', { 0: id }));
					const v = Math.floor(numberInRange(0, 1e12)(n));
					if (v > 0) out[id] = v;
				}
				return out;
			},
			describe: (c) =>
				text('{0}', {
					0: Object.entries(c).map(([id, n]) =>
						text('{0} ×{1}', { 0: keyText(resources.list().find((r) => r.id === id)?.name ?? id), 1: amount(n) }),
					),
				}),
			async give(api, playerId, c) {
				const capital = await capitalOf(api, playerId);
				const lines: RewardLine[] = [];
				for (const [id, n] of Object.entries(c)) {
					await resources.add(api, settlements.entity(capital.id), id, n);
					lines.push({ kind: 'resource', name: resources.list().find((r) => r.id === id)?.name ?? id, count: n });
				}
				return lines;
			},
		});

		puzzles.addRewardKind<{ item: string; count: number }>({
			id: 'item',
			name: 'Item',
			fields: [
				{
					name: 'item',
					label: text('Item'),
					type: 'select',
					options: () => items.list().map((i) => ({ value: i.id, label: keyText(i.name) })),
				},
				{ name: 'count', label: text('Count'), type: 'number', min: 1 },
			],
			parse: shape({ item: fields.oneOf(() => items.list().map((i) => i.id)), count: count(10_000) }),
			describe: (c) => text('{0} ×{1}', { 0: keyText(items.list().find((i) => i.id === c.item)?.name ?? c.item), 1: amount(c.count) }),
			async give(api, playerId, c) {
				await items.grant(api, playerId, c.item, c.count);
				return [{ kind: 'item', name: items.list().find((i) => i.id === c.item)?.name ?? c.item, count: c.count }];
			},
		});

		puzzles.addRewardKind<{ unit: string; count: number }>({
			id: 'troops',
			name: 'Troops',
			fields: [
				{
					name: 'unit',
					label: text('Unit'),
					type: 'select',
					options: () => troops.list().map((u) => ({ value: u.id, label: keyText(u.name) })),
				},
				{ name: 'count', label: text('Count'), type: 'number', min: 1 },
			],
			parse: shape({ unit: fields.oneOf(() => troops.list().map((u) => u.id)), count: count(1_000_000) }),
			describe: (c) => text('{0} ×{1}', { 0: keyText(troops.list().find((u) => u.id === c.unit)?.name ?? c.unit), 1: amount(c.count) }),
			async give(api, playerId, c) {
				const capital = await capitalOf(api, playerId);
				await troops.adjust(api, capital.id, c.unit, c.count);
				return [{ kind: 'troops', name: troops.list().find((u) => u.id === c.unit)?.name ?? c.unit, count: c.count }];
			},
		});

		// Equipment: a piece made like any drop. On a claim, refused when the capital's storage is full (the pieces stay, as a
		// chest stays shut); in a battle's loot it is lost (the report says so), as realm drops are.
		const gear = ctx.services.get('starterEquipment');
		const sets = gear.catalog().sets;
		const rarities = gear.catalog().rarities;
		puzzles.addRewardKind<{ set: string; rarity: string; piece: string | null }>({
			id: 'equipment',
			name: 'Equipment',
			fields: [
				{ name: 'set', label: text('Set'), type: 'select', options: () => sets.map((x) => ({ value: x.id, label: keyText(x.name) })) },
				{
					name: 'rarity',
					label: text('Colour'),
					type: 'select',
					options: () => rarities.map((r) => ({ value: r.id, label: keyText(r.name) })),
				},
				{
					name: 'piece',
					label: text('Piece (empty: any of the set)'),
					type: 'select',
					options: () =>
						sets.flatMap((x) =>
							x.pieces.map((p) => ({ value: p.id, label: text('{0} · {1}', { 0: keyText(x.name), 1: keyText(p.name) }) })),
						),
				},
			],
			parse(raw) {
				const c = shape({
					set: fields.oneOf(() => sets.map((x) => x.id)),
					rarity: fields.oneOf(() => rarities.map((r) => r.id)),
					piece: fields.optional(fields.text({ max: 80 })),
				})(raw);
				const piece = c.piece || null;
				if (piece && !sets.find((x) => x.id === c.set)!.pieces.some((p) => p.id === piece))
					throw fail('bad_config', text('That piece is not of the set'));
				return { set: c.set, rarity: c.rarity, piece };
			},
			describe: (c) => {
				const set = sets.find((x) => x.id === c.set)!;
				const piece = c.piece ? set.pieces.find((p) => p.id === c.piece) : null;
				return text('{0} {1}', {
					0: keyText(rarities.find((r) => r.id === c.rarity)?.name ?? c.rarity),
					1: keyText(piece?.name ?? set.name),
				});
			},
			async give(api, playerId, c, random, { inLoot }) {
				const capital = await capitalOf(api, playerId);
				return gear.make(api, playerId, capital.id, { set: c.set, rarity: c.rarity, ...(c.piece ? { piece: c.piece } : {}) }, random, {
					refuse: !inLoot,
				});
			},
		});

		// Permanent defence for a settlement the player picks on claiming (theirs: `requireOwned`, the claimer acting).
		const defense = ctx.services.get('starterDefense');
		puzzles.addRewardKind<{ amount: number }>({
			id: 'defense',
			name: 'Permanent defence',
			fields: [{ name: 'amount', label: text('Defence per lane'), type: 'number', min: 1 }],
			parse: shape({ amount: fields.int(1, 1e9) }),
			describe: (c) => text('Permanent defence +{0} in every lane of a settlement you choose', { 0: amount(c.amount) }),
			chooseSettlement: true,
			async give(api, _playerId, c, _random, { settlement }) {
				if (!settlement) throw fail('choose_settlement', 'Choose a settlement');
				const s = await settlements.requireOwned(api, settlement);
				await defense.addPermanent(api, s.id, c.amount);
				return [
					{
						kind: 'defense',
						name: 'starter-puzzles.Permanent defence',
						icon: '🛡️',
						label: text('{0}: defence +{1} in every lane', { 0: settlements.nameText(s), 1: amount(c.amount) }),
					},
				];
			},
		});

		const venueField = {
			name: 'venue',
			label: text('Recruited like at'),
			type: 'select' as const,
			options: () => heroes.venues().map((v) => ({ value: v.id, label: keyText(v.name) })),
		};
		const venueName = (id: string): UiText => keyText(heroes.venues().find((v) => v.id === id)?.name ?? id);
		const heroLine = (h: { surname: string; given: string }): RewardLine => ({ kind: 'hero', name: heroes.nameKey(h) });
		/** On a claim a full roster refuses (heroes.grant: the pieces stay); in loot the hero is lost instead (nothing written yet). */
		const grantHero = async (
			api: EngineApi,
			playerId: string,
			spec: Parameters<typeof heroes.grant>[3],
			random: () => number,
			inLoot?: boolean,
		) => {
			const capital = await capitalOf(api, playerId);
			try {
				return [heroLine(await heroes.grant(api, playerId, capital.id, spec, random))];
			} catch (err) {
				if (!inLoot || !(err instanceof GameError)) throw err;
				return [{ kind: 'hero', name: 'starter-puzzles.A heroine', lost: true }];
			}
		};

		puzzles.addRewardKind<{ venue: string }>({
			id: 'hero-female',
			name: 'A heroine',
			fields: [venueField],
			parse: shape({ venue: fields.oneOf(() => heroes.venues().map((v) => v.id)) }),
			describe: (c) => text('A heroine, recruited like at {0}', { 0: venueName(c.venue) }),
			give: (api, playerId, c, random, { inLoot }) => grantHero(api, playerId, { venue: c.venue, gender: 'f' }, random, inLoot),
		});

		puzzles.addRewardKind<{ venue: string; gender: 'm' | 'f' | 'any'; attrs: Record<string, number> }>({
			id: 'hero',
			name: 'A hero of the GM',
			fields: [
				venueField,
				{
					name: 'gender',
					label: text('Gender'),
					type: 'select',
					options: () => [
						{ value: 'any', label: text('Any') },
						{ value: 'f', label: text('Female') },
						{ value: 'm', label: text('Male') },
					],
				},
				...heroes.attributes().map((a) => ({ name: `attr:${a.id}`, label: keyText(a.name), type: 'number' as const, min: 0 })),
			],
			parse(raw) {
				const r = (raw ?? {}) as Record<string, unknown>;
				const base = shape({
					venue: fields.oneOf(() => heroes.venues().map((v) => v.id)),
					gender: fields.orElse(fields.oneOf(['m', 'f', 'any'] as const), 'any'),
				})(r);
				const attrs: Record<string, number> = {};
				for (const a of heroes.attributes()) {
					const v = r[`attr:${a.id}`];
					if (v !== undefined && v !== null && v !== '') attrs[a.id] = Math.floor(numberInRange(0, 10_000)(v));
				}
				return { ...base, attrs };
			},
			describe: (c) => text('A hero of the GM, recruited like at {0}', { 0: venueName(c.venue) }),
			give: (api, playerId, c, random, { inLoot }) =>
				grantHero(api, playerId, { venue: c.venue, ...(c.gender === 'any' ? {} : { gender: c.gender }), attrs: c.attrs }, random, inLoot),
		});
	},
});
