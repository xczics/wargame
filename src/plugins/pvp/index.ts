/**
 * Player-versus-player attacks: an encounter handler for armies arriving at another
 * player's settlement.
 *
 * The defending player is locked into the same atomic commit as the attacker, so the
 * battle, the defender's losses and the looting all happen together or not at all —
 * even if the defender is acting at the same moment (their command, or ours, retries).
 *
 * Defence is the garrison's `troops.power` (so hero modifiers and shortage penalties
 * count). If the attackers win they carry off resources, spread over what the defender
 * holds, up to what the survivors can carry. Settlements that cannot hold troops defend
 * with nothing.
 */
import { definePlugin, numberInRange } from '../../kernel';
import type { BattleReport, DefenseReport } from '../../shared/api';

export default definePlugin({
	id: 'pvp',
	version: '0.1.0',
	description: 'Attacks on other players: garrison battles and looting',
	dependsOn: ['armies', 'troops', 'settlements', 'resources', 'accounts', 'stats'],
	setup(ctx) {
		const armies = ctx.services.get('armies');
		const troops = ctx.services.get('troops');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const accounts = ctx.services.get('accounts');

		const protectionHours = ctx.config.define('protectionHours', {
			description: 'Hours after founding their capital during which a player cannot be attacked.',
			default: () => 72,
			parse: numberInRange(0, 24 * 365),
		});
		const stats = ctx.services.get('stats');
		// Amount of each resource that raiders can never take (warehouses raise it).
		stats.define({ id: 'pvp.protected', description: 'protected from raids', base: () => 0, min: 0 });

		const lootShare = ctx.config.define('lootShare', {
			description: 'Most of each resource a victorious attack can take (0-1), before carry limits.',
			default: () => 0.5,
			parse: numberInRange(0, 1),
		});

		ctx.views.add({
			id: 'pvp.defenses',
			async compute(api): Promise<DefenseReport[]> {
				const { results } = await api.db
					.prepare('SELECT id, attacker_id, settlement_id, at, report FROM pvp_reports WHERE defender_id = ? ORDER BY at DESC LIMIT 20')
					.bind(api.playerId)
					.all<{ id: string; attacker_id: string; settlement_id: string; at: number; report: string }>();
				const names = await accounts.usernames(api.db, [...new Set(results.map((r) => r.attacker_id))]);
				return results.map((r) => ({
					id: r.id,
					at: r.at,
					settlement: r.settlement_id,
					attackerName: names[r.attacker_id] ?? null,
					report: JSON.parse(r.report),
				}));
			},
		});

		armies.addEncounter(async (api, e): Promise<BattleReport | null> => {
			if (!e.occupant?.startsWith('settlement:')) return null;
			const target = await settlements.get(api, e.occupant.slice('settlement:'.length));
			if (!target?.ownerId || target.ownerId === e.army.playerId) return null; // NPCs and own settlements: not ours
			await api.lock(`player:${target.ownerId}`);
			const owner = (await accounts.usernames(api.db, [target.ownerId]))[target.ownerId] ?? null;

			const capital = await settlements.capital(api, target.ownerId);
			if (capital && e.at < capital.createdAt + protectionHours.get(api) * 3600_000) {
				return {
					target: { kind: target.kind, name: target.name, ownerName: owner },
					outcome: 'no-battle',
					note: 'Under beginner protection',
					attack: 0,
					defense: 0,
					losses: { attacker: {}, defender: {} },
					loot: {},
					captured: {},
				};
			}

			const { attack, factors: attackFactors } = await armies.attack(api, e);
			const defense = (await troops.power(api, target.id)).defense;
			const fight = armies.battle(attack, defense);

			const attackerLost = Object.fromEntries(
				Object.entries(e.army.units).map(([u, n]) => [u, Math.min(n, Math.round(n * fight.attackerLoss))]),
			);
			const defenderLost: Record<string, number> = {};
			for (const [unit, count] of await troops.garrison(api, target.id)) {
				const lost = Math.min(count, Math.round(count * fight.defenderLoss));
				if (lost > 0) {
					defenderLost[unit] = lost;
					await troops.adjust(api, target.id, unit, -lost);
				}
			}

			const loot: Record<string, number> = {};
			if (fight.victory) {
				const survivors = Object.fromEntries(Object.entries(e.army.units).map(([u, n]) => [u, n - (attackerLost[u] ?? 0)]));
				let carry = e.carry * (armies.attackOf(survivors) / Math.max(1, armies.attackOf(e.army.units)));
				const holder = settlements.entity(target.id);
				const available = await resources.amounts(api, holder);
				const safe = await stats.get(api, 'pvp.protected', holder);
				const takeable = Object.fromEntries(
					Object.entries(available).map(([r, n]) => [r, Math.max(0, Math.floor((n - safe) * lootShare.get(api)))]),
				);
				const total = Object.values(takeable).reduce((a, b) => a + b, 0);
				// Spread the carrying capacity over resources in proportion to what is there.
				const ratio = total > 0 ? Math.min(1, carry / total) : 0;
				for (const [r, n] of Object.entries(takeable)) {
					const take = Math.floor(n * ratio);
					if (take > 0 && carry > 0) {
						loot[r] = take;
						carry -= take;
					}
				}
				if (Object.keys(loot).length) await resources.spend(api, holder, loot);
			}

			const report: BattleReport = {
				target: { kind: target.kind, name: target.name, ownerName: owner },
				outcome: fight.victory ? 'victory' : 'defeat',
				attack,
				attackFactors,
				defense,
				losses: { attacker: attackerLost, defender: defenderLost },
				loot,
				captured: {},
			};
			// The defender's copy, committed atomically with the battle itself.
			api.write(
				api.db
					.prepare('INSERT INTO pvp_reports (id, defender_id, attacker_id, settlement_id, at, report) VALUES (?, ?, ?, ?, ?, ?)')
					.bind(crypto.randomUUID(), target.ownerId, e.army.playerId, target.id, e.at, JSON.stringify(report)),
			);
			return report;
		});
	},
});
