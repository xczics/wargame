/**
 * Puzzles (docs/design/gameplay.md §13): the GM makes a puzzle from a picture (a square, kept in the file bucket), cut
 * into grid x grid pieces ("A1" top left), says where each piece may drop and how likely, and what completing it
 * brings; players collect pieces from battles and claim the reward (up to a number of times each, the pieces cleared
 * every time). A piece one already has turns into something else when it drops again (the GM says what).
 *
 * Pieces drop through `loot`: a source for every pool ("*"), aimed by the places owners describe (`loot.siteOf`:
 * "realms/black-wind/0/2", "npc-camps/npc-outpost/2"...), each rule tried on its own with its chance (a drop with
 * `chance`), its value counting towards the roll. This plugin knows nothing of realms, camps or rewards: what a
 * reward can be (resources, items, heroes...) is the `rewards` plugin's register (`rewards.addKind`).
 *
 * The puzzles are edited on the GM's own screen (routes /api/gm/puzzles, command `puzzles.save`); every change moves
 * the rules' version on (`configStore.touch`), so the definitions are read again only then (kept per isolate by
 * version) and the players' catalog (static view `puzzles.catalog`) is baked again.
 */
import { definePlugin, type EngineApi, executeCommand, fields, gameErrors, type ReadApi, seededRandom, shape } from '../../kernel';
import { requestContext } from '../../runtime/context';
import { imageName, imageResponse, putImage, sniffImage } from '../../runtime/files';
import { json } from '../../lib/http';
import type { PuzzleDefData, PuzzleDropRule, PuzzleInfo, PuzzleProgress, Reward, PuzzlesGmData } from '../../shared/api';
import type { LootDrop } from '../loot';
import { literal, uiTexts } from '../../shared/i18n';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('puzzles');
const text = uiTexts('puzzles');

const MAX_GRID = 12;
const MAX_IMAGE = 3 * 1024 * 1024;
const STATUSES = ['draft', 'live', 'closed', 'hidden'] as const;
const PICTURE_TYPES = ['webp', 'png', 'jpg'] as const;
const PICTURE_NAME = imageName(PICTURE_TYPES);

export interface PuzzlesService {
	/** A player's puzzles (live or closed ones they have a piece of, or claimed): what they are and how far along. */
	progress(
		api: ReadApi,
		playerId: string,
	): Promise<{ id: string; name: string; grid: number; limit: number; pieces: number; claims: number }[]>;
}

declare module '../../kernel' {
	interface ServiceMap {
		puzzles: PuzzlesService;
	}
}

interface DefRow {
	id: string;
	name: string;
	grid: number;
	status: PuzzleDefData['status'];
	image: string | null;
	claim_limit: number;
	duplicate: string | null;
	drops: string;
	rewards: string;
}
const toDef = (r: DefRow): PuzzleDefData => ({
	id: r.id,
	name: r.name,
	grid: r.grid,
	status: r.status,
	image: r.image,
	limit: r.claim_limit,
	duplicate: r.duplicate ? (JSON.parse(r.duplicate) as Reward) : null,
	drops: JSON.parse(r.drops) as PuzzleDropRule[],
	rewards: JSON.parse(r.rewards) as Reward[],
});
/** "A1", "B12": the row's letter, the column's number. */
export const pieceName = (grid: number, piece: number) => `${String.fromCharCode(65 + Math.floor(piece / grid))}${(piece % grid) + 1}`;
const pieceId = (puzzle: string, piece: number) => `puzzles:${puzzle}:${piece}`;

/** The definitions by rules version (every edit moves it on): read once per isolate and version. */
let known: { version: number; defs: PuzzleDefData[]; bySite: Map<string, { def: PuzzleDefData; rule: PuzzleDropRule }[]> } | null = null;

export default definePlugin({
	id: 'puzzles',
	version: '0.1.0',
	description: 'Puzzles: pieces drop in battles where the GM says; a completed picture brings what the GM says',
	dependsOn: ['loot', 'rewards', 'accounts', 'gm', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const loot = ctx.services.get('loot');
		const rewards = ctx.services.get('rewards');

		async function defsOf(api: ReadApi) {
			// Without a rules version (engine tests' contexts) nothing says when to read again: read every time.
			const version = api.rulesVersion ?? -1;
			if (!known || known.version !== version || version < 0) {
				const { results } = await api.db.prepare('SELECT * FROM puzzles_defs').all<DefRow>();
				const defs = results.map(toDef);
				const bySite = new Map<string, { def: PuzzleDefData; rule: PuzzleDropRule }[]>();
				for (const def of defs)
					if (def.status === 'live')
						for (const rule of def.drops) for (const site of rule.sites) bySite.set(site, [...(bySite.get(site) ?? []), { def, rule }]);
				known = { version, defs, bySite };
			}
			return known;
		}
		const describe = (r: Reward) => rewards.describe(r);
		const give = (
			api: EngineApi,
			playerId: string,
			r: Reward,
			random: () => number,
			options: { inLoot?: boolean; settlement?: string } = {},
		) => rewards.give(api, playerId, r, random, options);

		/* ----- what a player has ---------------------------------------------------------------- */

		const piecesOf = (api: ReadApi, playerId: string) =>
			api.memo(`puzzles:pieces:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT puzzle_id, piece FROM puzzles_pieces WHERE player_id = ?')
					.bind(playerId)
					.all<{ puzzle_id: string; piece: number }>();
				const out = new Map<string, Set<number>>();
				for (const r of results) out.set(r.puzzle_id, (out.get(r.puzzle_id) ?? new Set()).add(r.piece));
				return out;
			});
		const claimsOf = (api: ReadApi, playerId: string) =>
			api.memo(`puzzles:claims:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT puzzle_id, count FROM puzzles_claims WHERE player_id = ?')
					.bind(playerId)
					.all<{ puzzle_id: string; count: number }>();
				return new Map(results.map((r) => [r.puzzle_id, r.count]));
			});

		/** A piece dropped: kept, or (had already, or claimed as often as allowed) turned into the duplicate's reward. */
		async function givePiece(
			api: EngineApi,
			playerId: string,
			def: PuzzleDefData,
			rule: PuzzleDropRule,
			piece: number,
			random: () => number,
		) {
			const pieces = await piecesOf(api, playerId);
			const have = pieces.get(def.id) ?? new Set<number>();
			const done = ((await claimsOf(api, playerId)).get(def.id) ?? 0) >= def.limit;
			// Which piece of which puzzle, in the report (the line's label; its name stays the key of "a puzzle piece").
			const which = { 0: pieceName(def.grid, piece), 1: literal(def.name) };
			if (have.has(piece) || done) {
				const dup = rule.duplicate ?? def.duplicate;
				const lines = dup ? await give(api, playerId, dup, random, { inLoot: true }) : [];
				return [
					{ kind: 'puzzle', name: 'Puzzle piece (had it already)', label: text('Piece {0} of "{1}" (had it already)', which), count: 1 },
					...lines,
				];
			}
			pieces.set(def.id, have.add(piece));
			api.write(api.db.prepare('INSERT INTO puzzles_pieces (player_id, puzzle_id, piece) VALUES (?, ?, ?)').bind(playerId, def.id, piece));
			return [{ kind: 'puzzle', name: 'Puzzle piece', label: text('Piece {0} of "{1}"', which), count: 1 }];
		}

		// Pieces drop wherever a live puzzle's rules aim, in every pool: the place of the occasion, then every place above it.
		loot.addSource<{ playerId?: string }>('*', async (api, c, pool) => {
			const site = loot.siteOf(pool, c);
			if (!site) return [];
			const { bySite } = await defsOf(api);
			if (!bySite.size) return [];
			const parts = site.split('/');
			const out: LootDrop<{ playerId?: string }>[] = [];
			for (let i = parts.length; i >= 1; i--)
				for (const { def, rule } of bySite.get(parts.slice(0, i).join('/')) ?? [])
					for (const piece of rule.pieces)
						out.push({
							id: pieceId(def.id, piece),
							weight: 0,
							chance: rule.chance,
							value: rule.value,
							give: async (a, cc) => givePiece(a, cc.playerId, def, rule, piece, cc.random),
						});
			return out;
		});

		/* ----- players: the catalog, their pieces, claiming ------------------------------------- */

		// What does not change with the player: baked again when the rules' version moves on (every puzzle edit does).
		ctx.statics.add({
			id: 'puzzles.catalog',
			// The puzzles table, not rules: baked again with every version (every puzzle edit moves it on).
			content: true,
			async compute({ db }) {
				const { results } = await db.prepare("SELECT * FROM puzzles_defs WHERE status IN ('live', 'closed')").all<DefRow>();
				return Object.fromEntries(
					results.map(toDef).map((d): [string, PuzzleInfo] => [
						d.id,
						{
							id: d.id,
							name: d.name,
							grid: d.grid,
							image: d.image,
							limit: d.limit,
							dropping: d.status === 'live',
							rewards: d.rewards.map(describe),
							duplicate: d.duplicate ? describe(d.duplicate) : null,
							...(d.rewards.some((r) => rewards.choosesSettlement(r)) ? { chooseSettlement: true } : {}),
						},
					]),
				);
			},
		});
		ctx.views.add({
			id: 'puzzles.mine',
			// Pieces come with battles (commits that lock the player), claims with the player's own commands.
			stamp: async (api) => `${await api.version(`player:${api.playerId}`)}|${api.rulesVersion ?? 0}`,
			async compute(api): Promise<PuzzleProgress[]> {
				const [pieces, claims, { defs }] = await Promise.all([piecesOf(api, api.playerId), claimsOf(api, api.playerId), defsOf(api)]);
				return defs
					.filter((d) => (d.status === 'live' || d.status === 'closed') && (pieces.has(d.id) || claims.has(d.id)))
					.map((d) => ({ id: d.id, pieces: [...(pieces.get(d.id) ?? [])].sort((a, b) => a - b), claims: claims.get(d.id) ?? 0 }));
			},
		});
		ctx.commands.add<{ puzzle: string; settlement?: string }>({
			type: 'puzzles.claim',
			description:
				'Claim the reward of a completed puzzle (its pieces are used up). Payload: { "puzzle": "<id>", "settlement"?: "<id>" (for rewards aimed at a settlement of the player\'s) }',
			parse: shape({ puzzle: fields.id(), settlement: fields.optional(fields.id()) }),
			async execute(api, { puzzle, settlement }) {
				const def = (await defsOf(api)).defs.find((d) => d.id === puzzle && (d.status === 'live' || d.status === 'closed'));
				if (!def) throw fail('not_found', 'No such puzzle');
				const have = (await piecesOf(api, api.playerId)).get(def.id) ?? new Set<number>();
				if (have.size < def.grid * def.grid)
					throw fail('incomplete', text('{0} pieces still missing', { 0: def.grid * def.grid - have.size }));
				const claims = (await claimsOf(api, api.playerId)).get(def.id) ?? 0;
				if (claims >= def.limit) throw fail('limit', text('Claimed as often as allowed ({0})', { 0: def.limit }));
				if (!settlement && def.rewards.some((r) => rewards.choosesSettlement(r)))
					throw fail('choose_settlement', 'Choose a settlement for the reward');
				const random = seededRandom(`puzzles:claim:${api.playerId}:${def.id}:${claims}`);
				for (const r of def.rewards) await give(api, api.playerId, r, random, settlement ? { settlement } : {});
				api.write(
					api.db.prepare('DELETE FROM puzzles_pieces WHERE player_id = ? AND puzzle_id = ?').bind(api.playerId, def.id),
					api.db
						.prepare(
							'INSERT INTO puzzles_claims (player_id, puzzle_id, count) VALUES (?, ?, 1) ON CONFLICT (player_id, puzzle_id) DO UPDATE SET count = count + 1',
						)
						.bind(api.playerId, def.id),
				);
				(await piecesOf(api, api.playerId)).delete(def.id);
				(await claimsOf(api, api.playerId)).set(def.id, claims + 1);
			},
		});

		/* ----- the GM's screen ------------------------------------------------------------------- */

		const reward = fields.object({ kind: fields.id(), config: fields.raw() });
		const checkReward = (r: { kind: string; config: unknown }): Reward => rewards.check(r);
		/** A duplicate is given in a battle's loot: nobody there to pick a settlement. */
		const checkDuplicate = (r: { kind: string; config: unknown }): Reward => {
			const out = checkReward(r);
			if (rewards.choosesSettlement(out)) throw fail('bad_payload', 'A reward aimed at a chosen settlement cannot be a duplicate piece’s');
			return out;
		};
		ctx.commands.add<PuzzleDefData>({
			type: 'puzzles.save',
			privileged: true,
			description:
				'Create or change a puzzle (the GM\'s puzzle screen). Payload: { "id"?, "name", "grid": 2-12, "status": "draft" | "live" | "closed" | "hidden", "image": "<bucket key>" | null, "limit": >= 1, "duplicate": { "kind", "config" } | null, "drops": [{ "pieces": [0, ...], "sites": ["realms/...", ...], "chance": 0-1, "value": >= 0, "duplicate"? }], "rewards": [{ "kind", "config" }] }',
			parse: shape(
				{
					id: fields.optional(fields.id()),
					name: fields.text({ max: 40 }),
					grid: fields.int(2, MAX_GRID),
					status: fields.oneOf(STATUSES),
					image: fields.optional(fields.text({ max: 200 })),
					limit: fields.int(1, 1000),
					duplicate: fields.optional(reward),
					drops: fields.list(
						fields.object({
							pieces: fields.list(fields.int(0, MAX_GRID * MAX_GRID - 1), { min: 1, max: MAX_GRID * MAX_GRID }),
							sites: fields.list(fields.text({ max: 200 }), { min: 1, max: 200 }),
							chance: fields.number(0, 1),
							value: fields.number(0, 1e6),
							duplicate: fields.optional(reward),
						}),
						{ min: 0, max: 500 },
					),
					rewards: fields.list(reward, { min: 0, max: 20 }),
				},
				(p): PuzzleDefData => {
					for (const d of p.drops)
						if (d.pieces.some((n) => n >= p.grid * p.grid))
							throw fail('bad_payload', text('Pieces go up to {0}', { 0: p.grid * p.grid - 1 }));
					if (p.image && !/^puzzles\/[0-9a-f]{20}\.(webp|png|jpg)$/.test(p.image)) throw fail('bad_payload', 'Upload the picture first');
					return {
						id: p.id ?? crypto.randomUUID(),
						name: p.name,
						grid: p.grid,
						status: p.status,
						image: p.image ?? null,
						limit: p.limit,
						duplicate: p.duplicate ? checkDuplicate(p.duplicate) : null,
						drops: p.drops.map((d) => ({ ...d, ...(d.duplicate ? { duplicate: checkDuplicate(d.duplicate) } : { duplicate: undefined }) })),
						rewards: p.rewards.map(checkReward),
					};
				},
			),
			async execute(api, def) {
				const was = (await defsOf(api)).defs.find((d) => d.id === def.id);
				// Players' pieces are numbered by the grid: it is fixed once the puzzle has left the draft.
				if (was && was.status !== 'draft' && was.grid !== def.grid)
					throw fail('fixed', 'The grid is fixed once the puzzle is out of the draft');
				api.write(
					api.db
						.prepare(
							`INSERT INTO puzzles_defs (id, name, grid, status, image, claim_limit, duplicate, drops, rewards, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
							 ON CONFLICT (id) DO UPDATE SET name = excluded.name, grid = excluded.grid, status = excluded.status, image = excluded.image,
							   claim_limit = excluded.claim_limit, duplicate = excluded.duplicate, drops = excluded.drops, rewards = excluded.rewards, updated_at = excluded.updated_at`,
						)
						.bind(
							def.id,
							def.name,
							def.grid,
							def.status,
							def.image,
							def.limit,
							def.duplicate ? JSON.stringify(def.duplicate) : null,
							JSON.stringify(def.drops.map(({ duplicate, ...d }) => (duplicate ? { ...d, duplicate } : d))),
							JSON.stringify(def.rewards),
							api.now,
						),
				);
				// Read again everywhere, the catalog baked again.
				ctx.services.get('configStore').touch?.(api);
			},
		});

		const gmContext = async (kernel: Parameters<typeof requestContext>[0], env: Env, request: Request) => {
			const gm = await ctx.services.get('accounts').requireGM(request, env);
			return { gm, context: await requestContext(kernel, env, gm.id, true) };
		};
		ctx.routes.add({
			method: 'GET',
			path: '/api/gm/puzzles',
			async handler({ kernel, request, env }) {
				const { context } = await gmContext(kernel, env, request);
				// The places' tree reads the rules only (e.g. each realm's tasks).
				const api = { ...context, db: env.DB, services: kernel.services } as unknown as ReadApi;
				const { results } = await env.DB.prepare('SELECT * FROM puzzles_defs ORDER BY updated_at DESC').all<DefRow>();
				return json({
					puzzles: results.map(toDef),
					kinds: rewards.kinds(),
					sites: await loot.sites(api),
					maxImage: MAX_IMAGE,
					maxGrid: MAX_GRID,
				} satisfies PuzzlesGmData);
			},
		});
		ctx.routes.add({
			method: 'POST',
			path: '/api/gm/puzzles',
			async handler({ kernel, request, env }) {
				const { gm, context } = await gmContext(kernel, env, request);
				const body = (await request.json().catch(() => null)) as unknown;
				await executeCommand(kernel, env.DB, context, 'puzzles.save', body);
				await ctx.services.get('gmAudit').record(env, gm.username, 'puzzles.save', body);
				return json({ ok: true });
			},
		});
		// The picture: cropped and scaled in the GM's browser (a Worker has no CPU for images), stored under its hash.
		ctx.routes.add({
			method: 'POST',
			path: '/api/gm/puzzles/image',
			async handler({ kernel, request, env }) {
				const { gm } = await gmContext(kernel, env, request);
				if (!env.FILES) throw fail('no_storage', 'No file bucket here');
				const bytes = new Uint8Array(await request.arrayBuffer());
				if (!bytes.length || bytes.length > MAX_IMAGE)
					throw fail('bad_payload', text('A picture of at most {0} MB', { 0: MAX_IMAGE / 1024 / 1024 }));
				const ext = sniffImage(bytes, PICTURE_TYPES);
				if (!ext) throw fail('bad_payload', 'Only WebP, PNG or JPEG pictures');
				const key = await putImage(env.FILES, 'puzzles', bytes, ext);
				await ctx.services.get('gmAudit').record(env, gm.username, 'puzzles.image', { key, bytes: bytes.length });
				return json({ key });
			},
		});
		// Pictures for players when the bucket has no public URL (FILES_BASE_URL): kept by browsers for good.
		ctx.routes.add({
			method: 'GET',
			path: '/api/files/puzzles/:name',
			async handler({ request, env, params, services }) {
				await services.get('session').resolve(request, env);
				const file = PICTURE_NAME.test(params.name) ? await env.FILES?.get(`puzzles/${params.name}`) : null;
				if (!file) return new Response('no such picture', { status: 404 });
				return imageResponse(file, 'private, max-age=31536000, immutable');
			},
		});

		// The GM's own screen: a tab of the GM console (its slot "gm-tabs"), drawn by the client plugin "puzzles".
		ctx.services.get('ui').slot({ slot: 'gm-tabs', widget: 'puzzles.gm', props: { label: text('Puzzles') } });

		ctx.services.provide('puzzles', {
			async progress(api, playerId) {
				const [pieces, claims, { defs }] = await Promise.all([piecesOf(api, playerId), claimsOf(api, playerId), defsOf(api)]);
				return defs
					.filter((d) => (d.status === 'live' || d.status === 'closed') && (pieces.has(d.id) || claims.has(d.id)))
					.map((d) => ({
						id: d.id,
						name: d.name,
						grid: d.grid,
						limit: d.limit,
						pieces: pieces.get(d.id)?.size ?? 0,
						claims: claims.get(d.id) ?? 0,
					}));
			},
		});
	},
});
