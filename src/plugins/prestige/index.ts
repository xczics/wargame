/**
 * Prestige (docs/design/gameplay.md §12.1): one number per player, raised by what the player spends
 * (every 1,000 resources spent: +1; refunds take it back) and by other plugins (`add`, e.g. beating
 * bandits, or losing to them). Ranks come from content (`defineRanks`): each has a threshold and may
 * raise stats; a player's rank follows the highest prestige they have reached, so it never falls.
 * "Recent" prestige (gains decaying over `rules.recentHours`) tells how fast a player is rising.
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
	shape,
} from '../../kernel';
import type { PrestigeStatus } from '../../shared/api';
import type { BadgeData } from '../../shared/ui';
import type { Cost } from '../resources';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { whole } from '../../shared/format';
import { keyText, uiTexts } from '../../shared/i18n';

const fail = gameErrors('prestige');
const text = uiTexts('prestige');

const RULES = csvRules(rulesCsv) as { perResource: number; recentHours: number };

export interface RankDef {
	name: string;
	/** Prestige needed (the first rank: 0). */
	threshold: number;
	/** Flat stat bonuses from this rank on (they add up over the ranks reached), e.g. { "settlements.limit.city": 1 }. */
	stats?: Record<string, number>;
}

export interface PrestigeState {
	value: number;
	best: number;
	/** Gains lately, decayed to now. */
	recent: number;
}

export interface PrestigeService {
	defineRanks(ranks: RankDef[]): void;
	/** Columns name, threshold, stats ("stat:n; stat:n"). */
	defineRanksFromCsv(csv: string): void;
	ranks(): readonly RankDef[];
	get(api: ReadApi, playerId: string): Promise<PrestigeState>;
	/** Add (or with a negative amount, take; never below zero). Gains count as recent. */
	add(api: EngineApi, playerId: string, amount: number): Promise<void>;
	/** Rank index (0-based) a prestige value reaches. */
	rankAt(value: number): number;
	/** The player's rank index (by their best prestige: it never falls). */
	rank(api: ReadApi, playerId: string): Promise<number>;
}

declare module '../../kernel' {
	interface ServiceMap {
		prestige: PrestigeService;
	}
}

export default definePlugin({
	id: 'prestige',
	version: '0.1.0',
	description: 'Prestige from spending and deeds; ranks that never fall',
	dependsOn: ['resources', 'settlements', 'stats', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const resources = ctx.services.get('resources');
		const settlements = ctx.services.get('settlements');
		const stats = ctx.services.get('stats');
		const rules = ctx.config.define('rules', {
			description: 'perResource: prestige per resource spent (0.001 = 1 per 1,000); recentHours: how long gains count as "recent".',
			default: () => RULES,
			parse: numberFields(() => RULES, 0, 1e6),
		});

		const RANKS: RankDef[] = [];
		const load = (api: ReadApi, playerId: string) =>
			api.memo(`prestige:${playerId}`, async () => {
				const row = await api.db
					.prepare('SELECT value, best, recent, recent_at FROM prestige_players WHERE player_id = ?')
					.bind(playerId)
					.first<{ value: number; best: number; recent: number; recent_at: number }>();
				return { value: row?.value ?? 0, best: row?.best ?? 0, recent: row?.recent ?? 0, at: row?.recent_at ?? api.now, dirty: false };
			});
		const decayed = (api: ReadApi, s: { recent: number; at: number }) =>
			s.recent * Math.exp(-Math.max(0, api.now - s.at) / (rules.get(api).recentHours * 3_600_000 || 1));

		const service: PrestigeService = {
			defineRanks(ranks) {
				if (RANKS.length) throw new PluginError('Prestige ranks defined twice');
				if (!ranks.length || ranks[0].threshold !== 0) throw new PluginError('The first prestige rank must start at 0');
				for (let i = 1; i < ranks.length; i++)
					if (!(ranks[i].threshold > ranks[i - 1].threshold))
						throw new PluginError(`Prestige rank "${ranks[i].name}": thresholds must rise`);
				const own = ctx.services.get('i18n').own;
				RANKS.push(...ranks.map((r) => ({ ...r, name: own(r.name) })));
				// Rank bonuses: the sum over the ranks the owner has reached.
				for (const stat of new Set(ranks.flatMap((r) => Object.keys(r.stats ?? {})))) {
					if (!stats.list().some((x) => x.id === stat)) throw new PluginError(`Prestige rank bonus: unknown stat "${stat}"`);
					stats.contribute(stat, async (api, target) => {
						const owner = target.startsWith('player:')
							? target.slice('player:'.length)
							: target.startsWith('settlement:')
								? ((await settlements.get(api, target.slice('settlement:'.length)))?.ownerId ?? null)
								: null;
						if (!owner) return null;
						const reached = await service.rank(api, owner);
						const flat = RANKS.slice(0, reached + 1).reduce((sum, r) => sum + (r.stats?.[stat] ?? 0), 0);
						return flat ? { flat } : null;
					});
				}
			},
			defineRanksFromCsv(csv) {
				service.defineRanks(
					csvRows(csv).map((r) => ({
						name: r.name,
						threshold: csvNumber(r, 'threshold'),
						...(r.stats ? { stats: csvMap(r.stats) } : {}),
					})),
				);
			},
			ranks: () => RANKS,
			async get(api, playerId) {
				const s = await load(api, playerId);
				return { value: s.value, best: s.best, recent: decayed(api, s) };
			},
			async add(api, playerId, amount) {
				if (!amount) return;
				const s = await load(api, playerId);
				const recent = decayed(api, s);
				s.value = Math.max(0, s.value + amount);
				s.best = Math.max(s.best, s.value);
				s.recent = recent + Math.max(0, amount);
				s.at = api.now;
				if (s.dirty) return;
				s.dirty = true;
				api.beforeCommit(`prestige:${playerId}`, () => {
					s.dirty = false;
					api.write(
						api.db
							.prepare(
								`INSERT INTO prestige_players (player_id, value, best, recent, recent_at) VALUES (?, ?, ?, ?, ?)
								 ON CONFLICT (player_id) DO UPDATE SET value = excluded.value, best = excluded.best, recent = excluded.recent, recent_at = excluded.recent_at`,
							)
							.bind(playerId, s.value, s.best, s.recent, s.at),
					);
				});
			},
			rankAt(value) {
				let i = 0;
				while (i + 1 < RANKS.length && value >= RANKS[i + 1].threshold) i++;
				return i;
			},
			async rank(api, playerId) {
				return service.rankAt((await load(api, playerId)).best);
			},
		};
		ctx.services.provide('prestige', service);

		// Spending raises prestige; refunds (cancelled work) take it back. Upkeep, supplies and losses do not count.
		const ownerOf = async (api: ReadApi, holder: string) =>
			holder.startsWith('settlement:') ? ((await settlements.get(api, holder.slice('settlement:'.length)))?.ownerId ?? null) : null;
		const total = (cost: Cost) => Object.values(cost).reduce((a, b) => a + Math.max(0, b), 0);
		resources.onSpent(async (api, { holder, cost, purpose }) => {
			if (purpose !== 'spend') return;
			const owner = await ownerOf(api, holder);
			if (owner) await service.add(api, owner, total(cost) * rules.get(api).perResource);
		});
		resources.onRefunded(async (api, { holder, cost }) => {
			const owner = await ownerOf(api, holder);
			if (owner) await service.add(api, owner, -total(cost) * rules.get(api).perResource);
		});

		ctx.views.add({
			id: 'prestige.status',
			async compute(api): Promise<PrestigeStatus | null> {
				if (!RANKS.length) return null;
				const s = await service.get(api, api.playerId);
				const i = service.rankAt(s.best);
				const next = RANKS[i + 1];
				return {
					value: s.value,
					best: s.best,
					rank: { index: i, name: RANKS[i].name },
					...(next ? { next: { name: next.name, threshold: next.threshold } } : {}),
				};
			},
		});

		// Rank and prestige next to the user name (generic badge widget); the tooltip says how far the next rank is.
		ctx.views.add({
			id: 'prestige.badge',
			async compute(api): Promise<BadgeData | null> {
				if (!RANKS.length) return null;
				const s = await service.get(api, api.playerId);
				const i = service.rankAt(s.best);
				const next = RANKS[i + 1];
				return {
					label: keyText(RANKS[i].name),
					value: text('Prestige {n}', { n: whole(s.value) }),
					title: next
						? text('Next: {rank} at {n} prestige (best so far {best})', {
								rank: keyText(next.name),
								n: whole(next.threshold),
								best: whole(s.best),
							})
						: text('The highest rank'),
				};
			},
		});

		ctx.commands.add<{ amount: number }>({
			type: 'prestige.grant',
			privileged: true,
			description: 'Add prestige to the player (negative to take, never below zero). Payload: { "amount": 100 }',
			form: {
				title: text('Give prestige'),
				placement: 'gm',
				fields: [{ name: 'amount', label: text('Prestige (negative to take)'), type: 'number', required: true, default: 100 }],
				submitLabel: text('Give'),
			},
			parse: shape({ amount: fields.number(-1e9, 1e9) }, (p) => {
				if (!p.amount) throw fail('bad_payload', 'amount must not be 0');
				return p;
			}),
			async execute(api, { amount }) {
				await service.add(api, api.playerId, amount);
			},
		});

		ctx.reports.add({
			id: 'prestige.players',
			description: 'Prestige of every player: now, best, gained lately.',
			async run(api) {
				const { results } = await api.db
					.prepare(
						'SELECT player_id AS playerId, value, best, recent, recent_at AS recentAt FROM prestige_players ORDER BY best DESC LIMIT 200',
					)
					.all();
				return results;
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.slot({ slot: 'user-actions', widget: 'ui.badge', props: { view: 'prestige.badge' } });
	},
});
