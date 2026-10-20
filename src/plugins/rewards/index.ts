/**
 * Rewards: what the GM can have a player given — a completed puzzle's reward, a mail's attachments... This plugin is only
 * the register: what a reward can be (resources, items, coupons, heroes...) is added by the plugins that own such things
 * (`rewards.addKind`, e.g. `starter-rewards`), and the plugins that give rewards (`puzzles`, `mail`) store them as
 * `{ kind, config }` and hand them out through `give`, knowing none of the kinds.
 *
 * It brings one kind of its own, "pool": one of several rewards, drawn by weight.
 *
 *   GET /api/gm/rewards   the kinds and the fields the GM fills in (GM only)
 */
import { definePlugin, type EngineApi, fields, gameErrors, PluginError, shape } from '../../kernel';
import { json } from '../../lib/http';
import type { Reward, RewardKindInfo, RewardLine } from '../../shared/api';
import type { UiText } from '../../shared/ui';
import { keyText, literal, uiTexts } from '../../shared/i18n';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('rewards');
const text = uiTexts('rewards');

/** A kind of reward: registered by the plugin that owns such things. */
export interface RewardKind<T = unknown> {
	id: string;
	/** An i18n key of the registering plugin. */
	name: string;
	/** What the GM fills in (the GM screens draw them). */
	fields: {
		name: string;
		label: UiText;
		type: 'number' | 'select' | 'text';
		options?: () => { value: string; label: UiText }[];
		min?: number;
		max?: number;
	}[];
	/** Check what the GM wrote (untrusted: throw this plugin's `bad_config`-like errors with a message). */
	parse(raw: unknown): T;
	/** What it is, for players ("Grain ×5,000", "A hero from the Music House"). */
	describe(config: T): UiText;
	/**
	 * The player picks one of their settlements when claiming (e.g. one to strengthen): `give` gets it as
	 * `options.settlement` (checking it is theirs is the kind's job). Such a reward can only be given where the player
	 * chooses (a claim), never in a battle's loot or a mail's attachment.
	 */
	chooseSettlement?: boolean | ((config: T) => boolean);
	/**
	 * Hand it to the player, in the same commit. On a claim it may refuse with a GameError (e.g. no room: then nothing is
	 * claimed). `inLoot`: given in a battle's loot (e.g. a duplicate puzzle piece) — never refuse there (the battle would
	 * not settle): what does not fit is lost, and its line says so (`lost`).
	 */
	give(api: EngineApi, playerId: string, config: T, random: () => number, options: GiveOptions): Promise<RewardLine[]>;
}

export interface GiveOptions {
	inLoot?: boolean;
	/**
	 * Past the player's limits where a kind has one (heroes: the roster's size). Puzzles give theirs so (user 2026-10-20:
	 * "拼图兑换的英雄，无视上限直接发给玩家"); mail attachments and the rest keep them.
	 */
	overLimits?: boolean;
	/** The settlement the player chose, for kinds that `chooseSettlement`. */
	settlement?: string;
}

export interface RewardsService {
	addKind<T>(kind: RewardKind<T>): void;
	/** A reward the GM wrote (`{ kind, config }`, untrusted), its settings checked by its kind. */
	check(raw: unknown): Reward;
	/** What it is, for players. */
	describe(reward: Reward): UiText;
	/** Hand it to the player in the current commit (may refuse with a GameError, see `RewardKind.give`). */
	give(api: EngineApi, playerId: string, reward: Reward, random: () => number, options?: GiveOptions): Promise<RewardLine[]>;
	/** Whether the player picks a settlement for it when claiming (`RewardKind.chooseSettlement`). */
	choosesSettlement(reward: Reward): boolean;
	/** The kinds, for GM screens. */
	kinds(): RewardKindInfo[];
}

declare module '../../kernel' {
	interface ServiceMap {
		rewards: RewardsService;
	}
}

export default definePlugin({
	id: 'rewards',
	version: '0.1.0',
	description: 'Rewards: the kinds of things the GM can have given (registered by their owners), checked and handed out',
	dependsOn: ['accounts', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const kinds = new Map<string, RewardKind>();
		const kindOf = (id: string) => {
			const k = kinds.get(id);
			if (!k) throw fail('bad_payload', text('Unknown reward kind "{0}"', { 0: id }));
			return k;
		};
		const parseReward = shape({ kind: fields.id(), config: fields.orElse(fields.raw(), {}) });
		const service: RewardsService = {
			addKind(kind) {
				if (kinds.has(kind.id)) throw new PluginError(`Reward kind "${kind.id}" added twice`);
				const own = ctx.services.get('i18n').scope();
				kinds.set(kind.id, { ...(kind as RewardKind), name: own(kind.name) });
			},
			check(raw) {
				const r = parseReward(raw);
				return { kind: r.kind, config: kindOf(r.kind).parse(r.config) };
			},
			describe(r) {
				const k = kinds.get(r.kind);
				return k ? k.describe(r.config) : literal(r.kind);
			},
			give: (api, playerId, r, random, options = {}) => kindOf(r.kind).give(api, playerId, r.config, random, options),
			choosesSettlement(r) {
				const c = kinds.get(r.kind)?.chooseSettlement;
				return typeof c === 'function' ? c(r.config) : !!c;
			},
			kinds: () =>
				[...kinds.values()].map((k) => ({
					id: k.id,
					name: keyText(k.name),
					fields: k.fields.map(({ options, ...f }) => ({ ...f, ...(options ? { options: options() } : {}) })),
				})),
		};
		ctx.services.provide('rewards', service);

		// A reward of rewards: one of several, drawn by weight (any other kind, not a pool again).
		kinds.set('pool', {
			id: 'pool',
			name: 'rewards.Random from a pool',
			fields: [],
			parse(raw) {
				return shape({
					options: fields.list(fields.object({ weight: fields.number(0, 1e6), kind: fields.id(), config: fields.raw() }), {
						min: 1,
						max: 20,
					}),
				})(raw).options.map((o) => {
					if (o.kind === 'pool') throw fail('bad_payload', 'A pool inside a pool');
					return { weight: o.weight, ...service.check(o) };
				});
			},
			describe: (options) => text('One of: {0}', { 0: (options as (Reward & { weight: number })[]).map(service.describe) }),
			chooseSettlement: (options) => (options as Reward[]).some((o) => service.choosesSettlement(o)),
			async give(api, playerId, options, random, mode) {
				const list = options as (Reward & { weight: number })[];
				let at = random() * list.reduce((a, o) => a + o.weight, 0);
				const pick = list.find((o) => (at -= o.weight) < 0) ?? list[list.length - 1];
				return service.give(api, playerId, pick, random, mode);
			},
		});

		const accounts = ctx.services.get('accounts');
		ctx.routes.add({
			method: 'GET',
			path: '/api/gm/rewards',
			async handler({ request, env }) {
				await accounts.requireGM(request, env);
				return json(service.kinds() satisfies RewardKindInfo[]);
			},
		});
	},
});
