/**
 * War reports: turns what happens to a player's troops into mail.
 *
 *   war-reports.march     an army of theirs reached its target (battle, transfer, founding...)
 *   war-reports.defense   one of their settlements was attacked
 *   war-reports.shortage  upkeep ran out and troops left or dropped a tier
 *
 * The systems involved (armies, pvp, troops) only announce their events; this plugin decides
 * what the player is told. Each message is committed with the event itself.
 */
import { definePlugin } from '../../kernel';
import type { DefenseMail, MarchMail, ShortageMail } from '../../shared/api';

export default definePlugin({
	id: 'war-reports',
	version: '0.1.0',
	description: 'Battle reports and troop notices, sent to the mailbox',
	dependsOn: ['mail', 'armies', 'pvp', 'troops', 'settlements', 'resources', 'accounts'],
	setup(ctx) {
		const mail = ctx.services.get('mail');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const accounts = ctx.services.get('accounts');
		const nameOf = async (api: Parameters<typeof settlements.get>[0], id: string | null) =>
			(id ? (await settlements.get(api, id))?.name : null) ?? '?';

		ctx.services.get('armies').onArrive(async (api, { army, tile, at, report, cargo, deliverTo, station }) => {
			const where = { x: tile.x, y: tile.y, target: await nameOf(api, deliverTo) };
			const title =
				army.mission === 'settle'
					? deliverTo
						? 'Settlement founded: {target}'
						: 'Expedition failed at ({x}, {y})'
					: army.mission === 'transfer'
						? station
							? 'Troops arrived at {target}'
							: deliverTo
								? 'Supplies delivered to {target}'
								: 'Transfer failed at ({x}, {y})'
						: report.outcome === 'victory'
							? 'Victory at ({x}, {y})'
							: report.outcome === 'defeat'
								? 'Defeat at ({x}, {y})'
								: 'Report from ({x}, {y})';
			mail.send(api, army.playerId, {
				kind: 'war-reports.march',
				title,
				vars: where,
				at,
				data: {
					mission: army.mission,
					from: army.from,
					target: tile,
					units: army.units,
					cargo,
					report,
					deliverTo,
					station,
				} satisfies MarchMail,
			});
		});

		ctx.services.get('pvp').onDefense(async (api, { defenderId, attackerId, settlementId, at, report }) => {
			const attackerName = (await accounts.usernames(api.db, [attackerId]))[attackerId] ?? null;
			mail.send(api, defenderId, {
				kind: 'war-reports.defense',
				// The report's outcome is the attacker's.
				title: report.outcome === 'victory' ? '{settlement} was raided by {name}' : '{settlement} repelled an attack by {name}',
				vars: { settlement: await nameOf(api, settlementId), name: attackerName ?? '?' },
				at,
				data: { settlement: settlementId, attackerName, report } satisfies DefenseMail,
			});
		});

		ctx.services.get('troops').onShortage(async (api, { settlementId, resource, at, routed, downgraded }) => {
			const s = await settlements.get(api, settlementId);
			if (!s?.ownerId) return;
			const res = resources.list().find((r) => r.id === resource);
			mail.send(api, s.ownerId, {
				kind: 'war-reports.shortage',
				title: Object.keys(routed).length
					? 'Troops deserted {settlement}: out of {resource}'
					: 'Troops in {settlement} lost a tier: out of {resource}',
				vars: { settlement: s.name, resource: res?.name ?? resource },
				at,
				data: { settlement: settlementId, resource, routed, downgraded } satisfies ShortageMail,
			});
		});
	},
});
