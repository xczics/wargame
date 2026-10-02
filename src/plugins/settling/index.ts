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
import { definePlugin, GameError } from '../../kernel';
import type { BattleReport } from '../../shared/api';
import type { SendOrder } from '../armies';
import i18nCsv from './data/i18n.csv?raw';

const NAME_MAX = 30;

interface Plan {
	kind: string;
	name: string;
}

const report = (target: BattleReport['target'], note: string): BattleReport => ({
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
	dependsOn: ['armies', 'settlements', 'stats', 'world-map', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const armies = ctx.services.get('armies');
		const settlements = ctx.services.get('settlements');
		const stats = ctx.services.get('stats');
		const map = ctx.services.get('worldMap');

		armies.defineMission<Plan>({
			id: 'settle',
			name: 'Found a settlement',
			cargo: true,
			check: async (_api, { occupant }) => (occupant ? 'That tile is already occupied' : null),
			async parse(api, raw, { tile }) {
				const kind = typeof raw.kind === 'string' ? raw.kind : '';
				const reason = await settlements.foundable(api, api.playerId, kind, tile);
				if (reason) throw new GameError('cannot_found', reason, 409);
				const k = settlements.kind(kind);
				const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : k.name;
				if (name.length > NAME_MAX) throw new GameError('bad_payload', `name: at most ${NAME_MAX} characters`);
				return { value: { kind, name }, cost: k.foundCost?.(api) ?? {} };
			},
			async arrive(api, { army, tile, value }) {
				const kind = settlements.kind(value.kind);
				const reason = await settlements.foundable(api, army.playerId, value.kind, tile);
				if (reason) return { report: report({ kind: 'empty' }, `Could not found the settlement: ${reason}`), refund: true };
				const id = await settlements.found(api, { kind: value.kind, ownerId: army.playerId, name: value.name, centre: tile });
				return { report: report({ kind: value.kind, name: value.name }, 'Settlement founded'), deliverTo: id, station: kind.garrison };
			},
		});

		ctx.commands.add<SendOrder>({
			type: 'settling.found',
			description:
				'Send an expedition to found a settlement on an empty tile. Payload as armies.send plus { "kind": "city", "name"?: "..." }, without "mission".',
			form: {
				title: 'Found a settlement here',
				description:
					'An expedition carries the founding materials and your supplies there. The troops stay as the garrison, or come back if the new settlement cannot hold one.',
				placement: 'tile',
				fields: [
					{ name: 'kind', label: 'Type', type: 'select', required: true },
					{ name: 'name', label: 'Name', type: 'text', maxLength: NAME_MAX, placeholder: 'optional' },
					{ name: 'from', label: 'From', type: 'select', required: true },
					{ name: 'x', label: 'x', type: 'hidden' },
					{ name: 'y', label: 'y', type: 'hidden' },
				],
				submitLabel: 'Send expedition',
				async prepare(api, params) {
					if (params.x === undefined || params.y === undefined) return false;
					const tile = { x: map.wrap(Number(params.x)), y: map.wrap(Number(params.y)) };
					if ((await map.occupants(api, [tile])).size) return false;
					const mine = await settlements.mine(api, api.playerId);
					const kinds: { value: string; label: string }[] = [];
					for (const k of settlements.kinds()) {
						if (k.npc || k.id === 'capital') continue;
						const have = mine.filter((s) => s.kind === k.id).length;
						const limit = k.limit ? await stats.get(api, `settlements.limit.${k.id}`, `player:${api.playerId}`) : Infinity;
						if (have >= limit) continue;
						const cost = Object.entries(k.foundCost?.(api) ?? {})
							.map(([r, n]) => `${n} ${r}`)
							.join(', ');
						kinds.push({ value: k.id, label: `${k.name} (${have}/${limit === Infinity ? '∞' : limit}) — ${cost || 'free'}` });
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
