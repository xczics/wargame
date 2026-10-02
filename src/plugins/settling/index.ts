/**
 * Settling: founding a settlement by sending an expedition (a march mission "settle").
 *
 * The expedition leaves from one of the player's settlements with troops, supplies (at most
 * what the troops can carry) and the founding materials (the kind's `foundCost`, paid at
 * departure, carried regardless of the troops' carry). On arrival at the empty tile the
 * settlement is founded and the supplies unloaded there; the troops stay as its garrison if
 * the kind can hold one, otherwise (a resource fortress) they go back home.
 * If the site is no longer possible when they arrive (taken meanwhile, limit reached), the
 * expedition comes back with everything it carried.
 */
import { definePlugin, fields, gameErrors, shape } from '../../kernel';
import type { BattleReport } from '../../shared/api';
import { amounts } from '../../shared/format';
import type { SendOrder } from '../armies';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, uiTexts } from '../../shared/i18n';
import type { UiText } from '../../shared/ui';

const fail = gameErrors('settling');
const text = uiTexts('settling');

const NAME_MAX = 30;

interface Plan {
	kind: string;
	name: string;
}

const report = (target: BattleReport['target'], note: UiText): BattleReport => ({
	target,
	outcome: 'no-battle',
	note,
	attack: 0,
	defense: 0,
	losses: { attacker: {}, defender: {} },
	loot: {},
	captured: {},
});

export default definePlugin({
	id: 'settling',
	version: '0.1.0',
	description: 'Found settlements by sending an expedition with troops and supplies',
	dependsOn: ['armies', 'settlements', 'stats', 'world-map', 'resources', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const armies = ctx.services.get('armies');
		const settlements = ctx.services.get('settlements');
		const stats = ctx.services.get('stats');
		const map = ctx.services.get('worldMap');

		const settleFields = shape({ kind: fields.orElse(fields.id(), ''), name: fields.optional(fields.text({ max: NAME_MAX })) });
		armies.defineMission<Plan>({
			id: 'settle',
			name: 'mission:settle',
			cargo: true,
			check: async (_api, { occupant }) => (occupant ? text('That tile is already occupied') : null),
			async parse(api, raw, { tile }) {
				const p = settleFields(raw);
				const reason = await settlements.foundable(api, api.playerId, p.kind, tile);
				if (reason) throw fail('cannot_found', reason, 409);
				const k = settlements.kind(p.kind);
				// Without a typed name, the kind's name (an i18n key, translated when shown).
				return { value: { kind: p.kind, name: p.name ?? k.name }, cost: k.foundCost?.(api) ?? {} };
			},
			async arrive(api, { army, tile, value }) {
				const kind = settlements.kind(value.kind);
				const reason = await settlements.foundable(api, army.playerId, value.kind, tile);
				if (reason) return { report: report({ kind: 'empty' }, text('Could not found the settlement: {0}', { 0: reason })), refund: true };
				const id = await settlements.found(api, { kind: value.kind, ownerId: army.playerId, name: value.name, centre: tile });
				return {
					report: report({ kind: value.kind, name: value.name }, text('Settlement founded')),
					deliverTo: id,
					station: kind.garrison,
				};
			},
		});

		ctx.commands.add<SendOrder>({
			type: 'settling.found',
			description:
				'Send an expedition to found a settlement on an empty tile. Payload as armies.send plus { "kind": "city", "name"?: "..." }, without "mission".',
			form: {
				title: text('Found a settlement here'),
				description: text(
					'An expedition carries the founding materials and your supplies there. The troops stay as the garrison, or come back if the new settlement cannot hold one.',
				),
				placement: 'tile',
				fields: [
					{ name: 'kind', label: text('Type'), type: 'select', required: true },
					{ name: 'name', label: text('Name'), type: 'text', maxLength: NAME_MAX, placeholder: text('optional') },
					{ name: 'from', label: text('From'), type: 'select', required: true },
					{ name: 'x', label: text('x'), type: 'hidden' },
					{ name: 'y', label: text('y'), type: 'hidden' },
				],
				submitLabel: text('Send expedition'),
				async prepare(api, params) {
					if (params.x === undefined || params.y === undefined) return false;
					const tile = { x: map.wrap(Number(params.x)), y: map.wrap(Number(params.y)) };
					if ((await map.occupants(api, [tile])).size) return false;
					const mine = await settlements.mine(api, api.playerId);
					const kinds: { value: string; label: UiText }[] = [];
					for (const k of settlements.kinds()) {
						if (k.npc || k.id === 'capital') continue;
						const have = mine.filter((s) => s.kind === k.id).length;
						const limit = k.limit ? await stats.get(api, `settlements.limit.${k.id}`, `player:${api.playerId}`) : Infinity;
						if (have >= limit) continue;
						const icons = Object.fromEntries(
							ctx.services
								.get('resources')
								.list()
								.map((r) => [r.id, r.icon ?? r.id]),
						);
						const cost = amounts(k.foundCost?.(api) ?? {}, icons);
						kinds.push({
							value: k.id,
							label: text('{0} ({1}/{2}) — {3}', {
								0: keyText(k.name),
								1: have,
								2: limit === Infinity ? '∞' : limit,
								3: cost || text('free'),
							}),
						});
					}
					if (!kinds.length) return false;
					const send = await armies.sendForm(api, params, 'settle');
					if (!send) return false;
					return { ...send, options: { ...send.options, kind: kinds } };
				},
			},
			parse: (raw) => armies.parseOrder(raw, 'settle'),
			execute: async (api, order) => void (await armies.dispatch(api, order)),
		});
	},
});
