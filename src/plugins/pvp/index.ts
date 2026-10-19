/**
 * Player-versus-player attacks: an encounter handler for armies arriving at another
 * player's settlement.
 *
 * The defending player is locked into the same atomic commit as the attacker, so the
 * battle, the defender's losses and the looting all happen together or not at all —
 * even if the defender is acting at the same moment (their command, or ours, retries).
 *
 * The fight itself is the battle plugin's: the army's lanes against the garrison in the
 * settlement's defence formation (walls and other modifiers included). Winning 3+ lanes, the
 * attackers carry off a share of each resource (by result), except what is protected
 * (`pvp.protected`, e.g. a hidden store), up to what the survivors can carry.
 * Settlements that cannot hold troops defend with their walls alone.
 */
import {
	csvRules,
	definePlugin,
	type EngineApi,
	fields,
	gameErrors,
	numberInRange,
	PluginError,
	type ReadApi,
	seededRandom,
	shape,
} from '../../kernel';
import { duration } from '../../shared/format';
import type { BattleReport, RewardLine } from '../../shared/api';
import type { BattleResult, BattleSide, Lane } from '../battle';
import type { Settlement } from '../settlements';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { uiTexts } from '../../shared/i18n';

const fail = gameErrors('pvp');
const text = uiTexts('pvp');

/** Design numbers (./data/rules.csv); GM overrides go on top. */
const RULES = csvRules(rulesCsv);

/** A player's settlement was attacked (the battle is final). Runs in the attacker's timeline, defender locked. */
export type DefenseListener = (
	api: EngineApi,
	defense: { defenderId: string; attackerId: string | null; settlementId: string; at: number; report: BattleReport },
) => Promise<void>;

export interface RaidInput {
	/** A player's settlement. */
	target: Settlement;
	attacker: { side: BattleSide; lanes: Lane[]; units: Record<string, number> };
	/** The attacking player, or null (e.g. bandits: then `attackerInfo` names them). */
	attackerId: string | null;
	attackerInfo?: { name: string; level?: number };
	at: number;
	/** After the battle and plunder, before the report is kept: what else came of it for the defender. */
	after?: (fight: BattleResult, loot: Record<string, number>) => Promise<{ rewards?: RewardLine[]; prestige?: number }>;
}

/**
 * The loot pool of attacks on players: what a winning attacker may find besides the plunder. Empty by
 * default; other plugins fill it with `loot.addDrop<PvpOccasion>('pvp', ...)`.
 */
const POOL = 'pvp';
export interface PvpOccasion {
	attackerId: string;
	defenderId: string;
	settlement: Settlement;
	/** The attacker's result, e.g. "crushing". */
	grade: string;
}

export interface PvpService {
	onDefense(listener: DefenseListener): void;
	/**
	 * An attack on a player's settlement: the garrison defends in its formation (walls and the rest as
	 * modifiers), losses and promotions apply, winners of 3+ lanes plunder (§3.9), the defender gets a
	 * report and `onDefense` listeners run. Locks the defender. The attacker's own losses are the caller's.
	 */
	raid(api: EngineApi, input: RaidInput): Promise<{ report: BattleReport; fight: BattleResult }>;
}

declare module '../../kernel' {
	interface ServiceMap {
		pvp: PvpService;
	}
}

export default definePlugin({
	id: 'pvp',
	version: '0.1.0',
	description: 'Attacks on other players: garrison battles and looting',
	dependsOn: ['armies', 'troops', 'settlements', 'resources', 'accounts', 'stats', 'battle', 'loot', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const armies = ctx.services.get('armies');
		const troops = ctx.services.get('troops');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const accounts = ctx.services.get('accounts');
		const battle = ctx.services.get('battle');
		const defenseListeners: DefenseListener[] = [];

		const protectionHours = ctx.config.define('protectionHours', {
			description: 'Hours after founding their capital during which a player cannot be attacked.',
			default: () => RULES.protectionHours as number,
			parse: numberInRange(0, 24 * 365),
		});
		/** What the GM set for a player (`pvp.protect`): until when, instead of the hours after their capital; null: nothing set. */
		const setFor = (api: ReadApi, playerId: string) =>
			api.memo(`pvp:protection:${playerId}`, async () => ({
				until: (await api.db.prepare('SELECT until FROM pvp_protection WHERE player_id = ?').bind(playerId).first<number>('until')) ?? null,
			}));
		/** Until when a player cannot be attacked (0: not protected). Only the attacked side is: the protected may attack. */
		async function protectedUntil(api: ReadApi, playerId: string) {
			const set = await setFor(api, playerId);
			if (set.until !== null) return set.until;
			const capital = await settlements.capital(api, playerId);
			return capital ? capital.createdAt + protectionHours.get(api) * 3600_000 : 0;
		}

		const stats = ctx.services.get('stats');
		// Amount of each resource that raiders can never take (warehouses raise it).
		stats.define({ id: 'pvp.protected', description: 'protected from raids', base: () => 0, min: 0 });

		const SHARES = RULES.loot as { crushing: number; victory: number; narrow: number };
		const lootShares = ctx.config.define('lootShares', {
			description:
				'Share (0-1) of each resource the attacker takes, by its result: crushing (5 lanes), victory (4), narrow (3). Fewer lanes: nothing.',
			default: () => SHARES,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw fail('bad_config', 'Expected { result: share }');
				const out: Record<string, number> = { ...SHARES };
				for (const [k, v] of Object.entries(raw)) {
					if (!(k in SHARES))
						throw fail('bad_config', text('Unknown result "{0}" (known: {1})', { 0: k, 1: Object.keys(SHARES).join(', ') }));
					out[k] = numberInRange(0, 1)(v);
				}
				return out as typeof SHARES;
			},
		});

		ctx.services.get('loot').definePool(POOL);
		// One place: a won attack on a player.
		ctx.services.get('loot').describeSites<PvpOccasion>(POOL, { label: text('Attacks on players'), tree: async () => [], path: () => [] });
		const lootValue = ctx.config.define('lootValue', {
			description:
				'What a won attack on a player brings from the pool of attacks on players, at least (the loot algorithm; nothing while the pool is empty).',
			default: () => RULES.lootValue as number,
			parse: numberInRange(0, 1e6),
		});
		const service: PvpService = {
			onDefense: (l) => void defenseListeners.push(l),
			async raid(api, { target, attacker, attackerId, attackerInfo, at, after }) {
				if (!target.ownerId) throw new PluginError('pvp.raid: not a player settlement');
				await api.lock(`player:${target.ownerId}`);
				const owner = (await accounts.usernames(api.db, [target.ownerId]))[target.ownerId] ?? null;
				const garrison = Object.fromEntries(await troops.garrison(api, target.id));
				const formation = await battle.fixFormation(api, target.id);
				const fight = await battle.fight(api, {
					attacker,
					defender: {
						side: { role: 'defender', playerId: target.ownerId, settlement: target },
						lanes: battle.defenderLanes(garrison, formation),
						units: garrison,
					},
				});
				const attackerLost = fight.losses.attacker;
				const defenderLost = fight.losses.defender;
				for (const [unit, lost] of Object.entries(defenderLost)) await troops.adjust(api, target.id, unit, -lost);
				for (const p of fight.promotions.defender) {
					await troops.adjust(api, target.id, p.from, -p.count);
					await troops.adjust(api, target.id, p.to, p.count);
				}

				// Plunder (§3.9): a share of each stock by result, never what the hidden store
				// protects, and no more in all than the survivors can carry.
				const loot: Record<string, number> = {};
				const grade = fight.detail.grade.attacker;
				const mods = fight.detail.modifiers.attacker;
				const pct = (stat: string) => mods.filter((m) => m.stat === stat).reduce((x, m) => x + (m.percent ?? 0), 0);
				const share = (grade in lootShares.get(api) ? lootShares.get(api)[grade as keyof typeof SHARES] : 0) * (1 + pct('loot') / 100);
				if (share > 0) {
					const survivors = Object.fromEntries(Object.entries(attacker.units).map(([u, n]) => [u, n - (attackerLost[u] ?? 0)]));
					const flatCarry = mods.filter((m) => m.stat === 'carry').reduce((x, m) => x + (m.flat ?? 0), 0);
					const carry = Math.max(0, (troops.totals(api, survivors).carry + flatCarry) * (1 + pct('carry') / 100));
					const holder = settlements.entity(target.id);
					const available = await resources.amounts(api, holder);
					const safe = await stats.get(api, 'pvp.protected', holder);
					const wanted = Object.fromEntries(
						Object.entries(available).map(([r, n]) => [r, Math.max(0, Math.min(Math.floor(n * share), Math.floor(n - safe)))]),
					);
					const total = Object.values(wanted).reduce((x, y) => x + y, 0);
					// Over the carry limit: every resource shrinks by the same ratio; the rest stays behind.
					const ratio = total > carry ? carry / total : 1;
					for (const [r, n] of Object.entries(wanted)) {
						const take = Math.floor(n * ratio);
						if (take > 0) loot[r] = take;
					}
					if (Object.keys(loot).length) await resources.spend(api, holder, loot, 'loss');
				}

				// A player's win may bring more: the loot pool of attacks on players (empty unless a plugin fills it).
				const drops = ctx.services.get('loot');
				const spoils: RewardLine[] = [];
				if (attackerId && fight.victory && !drops.empty(POOL)) {
					const random = seededRandom(`pvp-loot:${attackerId}:${target.id}:${at}`);
					const occasion: PvpOccasion = { attackerId, defenderId: target.ownerId, settlement: target, grade };
					const ids = await drops.roll(api, POOL, occasion, lootValue.get(api), random);
					spoils.push(...(await drops.give(api, POOL, ids, { ...occasion, playerId: attackerId, random })));
				}

				const more = after ? await after(fight, loot) : {};
				const report: BattleReport = {
					target: { kind: target.kind, name: target.name, ownerName: owner },
					...(attackerInfo ? { attacker: attackerInfo } : {}),
					...(more.rewards?.length ? { rewards: more.rewards } : {}),
					...(spoils.length ? { spoils } : {}),
					...(more.prestige ? { prestige: more.prestige } : {}),
					outcome: fight.victory ? 'victory' : 'defeat',
					attack: fight.attack,
					defense: fight.defense,
					battle: fight.detail,
					promoted: fight.promotions,
					losses: { attacker: attackerLost, defender: defenderLost },
					loot,
					captured: {},
				};
				for (const l of defenseListeners) await l(api, { defenderId: target.ownerId, attackerId, settlementId: target.id, at, report });
				return { report, fight };
			},
		};
		ctx.services.provide('pvp', service);

		// The GM, for the player chosen in the console: extend, set anew or lift their beginner protection.
		ctx.commands.add<{ action: 'extend' | 'reset' | 'cancel'; hours: number }>({
			type: 'pvp.protect',
			privileged: true,
			description:
				'Beginner protection of the player: "extend" adds `hours` (from now if it is over), "reset" makes it `hours` from now, "cancel" lifts it. Payload: { "action": "extend" | "reset" | "cancel", "hours"?: number }',
			form: {
				title: text('Beginner protection'),
				placement: 'gm',
				fields: [
					{
						name: 'action',
						label: text('Action'),
						type: 'select',
						required: true,
						options: [
							{ value: 'extend', label: text('Extend by') },
							{ value: 'reset', label: text('Set anew: from now') },
							{ value: 'cancel', label: text('Cancel') },
						],
					},
					{ name: 'hours', label: text('Hours'), type: 'number', min: 0, max: 24 * 365 },
				],
				submitLabel: text('Apply'),
				async prepare(api) {
					const left = (await protectedUntil(api, api.playerId)) - api.now;
					return {
						defaults: { action: 'extend', hours: protectionHours.get(api) },
						description: left > 0 ? text('Protected for {0} more.', { 0: duration(left / 1000) }) : text('Not protected.'),
					};
				},
			},
			parse: shape({ action: fields.oneOf(['extend', 'reset', 'cancel'] as const), hours: fields.orElse(fields.number(0, 24 * 365), 0) }),
			async execute(api, { action, hours }) {
				if (action !== 'cancel' && !(hours > 0)) throw fail('bad_payload', 'Give the hours');
				const now = await protectedUntil(api, api.playerId);
				const until = action === 'cancel' ? 0 : Math.round((action === 'extend' ? Math.max(now, api.now) : api.now) + hours * 3600_000);
				(await setFor(api, api.playerId)).until = until;
				api.write(
					api.db
						.prepare(
							'INSERT INTO pvp_protection (player_id, until) VALUES (?, ?) ON CONFLICT (player_id) DO UPDATE SET until = excluded.until',
						)
						.bind(api.playerId, until),
				);
			},
		});

		armies.addEncounter(async (api, e): Promise<BattleReport | null> => {
			if (!e.occupant?.startsWith('settlement:')) return null;
			const target = await settlements.get(api, e.occupant.slice('settlement:'.length));
			if (!target?.ownerId || target.ownerId === e.army.playerId) return null; // NPCs and own settlements: not ours
			await api.lock(`player:${target.ownerId}`);
			const owner = (await accounts.usernames(api.db, [target.ownerId]))[target.ownerId] ?? null;

			if (e.at < (await protectedUntil(api, target.ownerId))) {
				return {
					target: { kind: target.kind, name: target.name, ownerName: owner },
					outcome: 'no-battle',
					note: text('Under beginner protection'),
					attack: 0,
					defense: 0,
					losses: { attacker: {}, defender: {} },
					loot: {},
					captured: {},
				};
			}

			const { report } = await service.raid(api, {
				target,
				attacker: {
					side: { role: 'attacker', playerId: e.army.playerId, settlement: await settlements.get(api, e.army.from), armyId: e.army.id },
					lanes: battle.attackerLanes(e.army.options, e.army.units),
					units: e.army.units,
				},
				attackerId: e.army.playerId,
				at: e.at,
			});
			return report;
		});
	},
});
