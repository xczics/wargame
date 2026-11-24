/**
 * Hero rebirth (docs/design/gameplay.md §17.1; user 2026-11-16): a hero of level 90 or more, with a rebirth pill, may
 * start over at level 1. The Nth rebirth works with a chance of 1/N (the first always), sure after 2N failures in a row
 * (never shown); a failure costs the pill only. Reborn: the talent points its levels gave come off, what it was born with
 * and the free points spent stay, 6 x N free points more, and its talent grows by 2-6 points, each to its lowest talent
 * ("填平原则"). Nine at most. Whether a hero may be reborn is whether it may change its equipment (`heroes.requireFree`).
 */
import { csvRules, definePlugin, type EngineApi, fields, gameErrors, numberFields, type ReadApi, type RuleView, shape } from '../../kernel';
import type { RebirthCardData, RebirthFormData, RebirthReborn, RebirthRules } from '../../shared/api';
import { keyText, uiTexts } from '../../shared/i18n';
import { PILL, realmText } from '../../shared/rebirth';
import type { Hero } from '../heroes';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('rebirth');
const text = uiTexts('rebirth');
type Rules = { minLevel: number; max: number; pity: number; freePer: number; talentMin: number; talentMax: number };
const RULES = csvRules(rulesCsv) as Rules;

export interface RebirthService {
	/** How many times the hero was reborn (0: never). */
	count(api: ReadApi, playerId: string, heroId: string): Promise<number>;
	/** One try with a pill (the caller takes it): reborn or not; the next count when it worked. */
	attempt(api: EngineApi, hero: Hero): Promise<{ ok: boolean; count: number }>;
}

declare module '../../kernel' {
	interface ServiceMap {
		rebirth: RebirthService;
	}
}

/** Talent points one by one, each to the lowest talent (ties at random): `talents` the hero's now. */
export function fillTalents(talents: Record<string, number>, ids: readonly string[], points: number, random: () => number) {
	const now = Object.fromEntries(ids.map((a) => [a, talents[a] ?? 0]));
	const add: Record<string, number> = {};
	for (let i = 0; i < points; i++) {
		const low = Math.min(...ids.map((a) => now[a]));
		const tied = ids.filter((a) => now[a] === low);
		const a = tied[Math.min(tied.length - 1, Math.floor(random() * tied.length))];
		now[a]++;
		add[a] = (add[a] ?? 0) + 1;
	}
	return add;
}

export default definePlugin({
	id: 'rebirth',
	version: '0.1.0',
	description: 'Heroes reborn at level 90 with a rebirth pill: talent grows, free points come; nine times at most',
	dependsOn: ['heroes', 'items', 'mail', 'i18n'],
	tables: ['rebirth_heroes'],
	setup(ctx) {
		// Its mail, deleted a kind at a time from the mailbox (user 2026-11-20: "按邮件类型批量删除邮件").
		ctx.services.get('mail').nameKind('rebirth.result', 'Rebirth results');
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const heroes = ctx.services.get('heroes');
		const items = ctx.services.get('items');
		const mail = ctx.services.get('mail');
		const rules = ctx.config.define('rules', {
			description:
				'minLevel: level to be reborn from; max: rebirths at most; pity: the Nth is sure after pity x N failures in a row; freePer: free points x N for the Nth; talentMin / talentMax: talent points a rebirth adds (to the lowest talents).',
			default: () => ({ ...RULES }),
			parse: numberFields(() => ({ ...RULES }), 0, 1e6),
		});
		const rule = (api: RuleView) => rules.get(api) as Rules;

		// Every hero of the player's at once (the hero cards ask for each).
		const loadCounts = (api: ReadApi, playerId: string) =>
			api.memo(`rebirth:counts:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT hero_id, count FROM rebirth_heroes WHERE player_id = ?')
					.bind(playerId)
					.all<{ hero_id: string; count: number }>();
				return new Map(results.map((r) => [r.hero_id, r.count]));
			});
		const random = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;

		const service: RebirthService = {
			count: async (api, playerId, heroId) => (await loadCounts(api, playerId)).get(heroId) ?? 0,
			async attempt(api, hero) {
				const r = rule(api);
				heroes.requireFree(hero);
				const counts = await loadCounts(api, hero.playerId);
				const done = counts.get(hero.id) ?? 0;
				if (done >= r.max) throw fail('blocked', text('Reborn {0} times already: no more', { 0: r.max }));
				if (hero.level < r.minLevel) throw fail('blocked', text('A hero is reborn from level {0}', { 0: r.minLevel }));
				const n = done + 1;
				// The Nth: 1 in N, sure after pity x N failures in a row; failures never forgotten.
				const o = await items.attempt(api, { target: `rebirth:${hero.id}:${n}`, chance: 1 / n, pity: r.pity * n + 1, forgetDays: 36_500 });
				const name = { text: 'i18n.{0}', vars: { 0: keyText(heroes.nameKey(hero)) } };
				if (!o.ok) {
					mail.send(api, hero.playerId, {
						kind: 'rebirth.result',
						title: text('{0}: the rebirth did not take, still {1}', { 0: name, 1: realmText(done) }),
					});
					return { ok: false, count: done };
				}
				const points = r.talentMin + Math.floor(random() * (Math.max(r.talentMin, r.talentMax) - r.talentMin + 1));
				const talents = fillTalents(
					hero.talents ?? {},
					heroes.attributes().map((a) => a.id),
					points,
					random,
				);
				await heroes.reincarnate(api, hero.id, { talents, freePoints: r.freePer * n });
				// What was rolled (none on a failure: nothing changed): the browser rebirths the hero it holds the same way.
				api.reply('rebirth.reborn', { hero: hero.id, talents, freePoints: r.freePer * n } satisfies RebirthReborn);
				counts.set(hero.id, n);
				api.write(
					api.db
						.prepare(
							'INSERT INTO rebirth_heroes (hero_id, player_id, count) VALUES (?, ?, ?) ON CONFLICT (hero_id) DO UPDATE SET count = excluded.count',
						)
						.bind(hero.id, hero.playerId, n),
				);
				mail.send(api, hero.playerId, {
					kind: 'rebirth.result',
					title: text('{0} is reborn into {1}: talent +{2}, free points +{3}', { 0: name, 1: realmText(n), 2: points, 3: r.freePer * n }),
				});
				return { ok: true, count: n };
			},
		};
		ctx.services.provide('rebirth', service);
		// The rule's level and most rebirths, for the pill's form and the stars in the browser (baked with the rules).
		ctx.statics.add({
			id: 'rebirth.rules',
			compute: ({ rules: view }): RebirthRules => {
				const r = rule(view);
				return { minLevel: r.minLevel, max: r.max };
			},
		});

		// The card's stars (the rebirth client plugin draws them).
		heroes.addCardData(ctx.pluginId, async (api, h): Promise<RebirthCardData | undefined> => {
			const n = (await loadCounts(api, h.playerId)).get(h.id) ?? 0;
			return n ? { count: n, max: rule(api).max } : undefined;
		});

		// The pill: on a hero who may be reborn now.
		items.define<{ hero: string }>({
			id: PILL,
			name: 'Rebirth pill',
			icon: 'elixir',
			description:
				'A hero of level 90 or more starts over at level 1: talent grows, free points come. The Nth rebirth takes one time in N (the first always); a failure costs only the pill. Nine at most.',
			category: 'heroes',
			shortcuts: ['page:heroes'],
			use: {
				parse: shape({ hero: fields.id() }),
				async apply(api, { hero }) {
					await service.attempt(api, await heroes.requireOwned(api, api.playerId, hero));
				},
				form: {
					title: text('Use a rebirth pill'),
					fields: [{ name: 'hero', label: text('Hero'), type: 'select', required: true }],
					submitLabel: text('Rebirth'),
					confirm: text('Use a rebirth pill? The hero goes back to level 1 if it works.'),
					// Which heroes may be reborn now (their level, duty, talents change with play) the browser takes from the
					// heroes it holds (web/plugins/rebirth/parts.ts); sent: the rule's numbers and how often each was reborn.
					async prepare(api) {
						const data: Partial<RebirthFormData> = {
							'rebirth.heroes': { counts: Object.fromEntries(await loadCounts(api, api.playerId)) },
						};
						return { data };
					},
				},
			},
		});
	},
});
