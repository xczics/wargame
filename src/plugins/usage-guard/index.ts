/**
 * The usage guard (user 2026-10-19: "R2开通必须绑定银行卡，还会自动收费。需要提前帮我加个墙，每月R2免费额度用超80%（任意）之后，就自动
 * 停止workers"): on Cloudflare, Workers and D1 on the free plan only fail past their limits, but R2 past its free tier is
 * billed. So every few minutes a background task asks Cloudflare's analytics what R2 used this month (storage, class A
 * and class B operations); when any reaches the threshold (50%, a GM rule; analytics lag minutes) the game pauses:
 *
 *   - every `/api` request but the GM's and logging in answers 503 (a gate, before any route), so players reach no R2;
 *   - background tasks stop (all but this check);
 *   - the bucket's public domain (FILES_BASE_URL), which browsers reach without the Worker, is switched off.
 *
 * When the month turns and usage is below the threshold again, it all comes back by itself (the GM may also lift it:
 * `usage-guard.resume`; a check a minute later pauses again if still over).
 *
 * Needs, on Cloudflare: the secret CF_API_TOKEN (Account Analytics: Read; Workers R2 Storage: Edit) and the vars
 * CF_ACCOUNT_ID and FILES_BUCKET (the bucket's name). Without them (local runs, Docker) it does nothing.
 */
import { csvRules, definePlugin, gameErrors, loadConfig, numberFields, numberInRange, type ReadApi, shape } from '../../kernel';
import { errorResponse } from '../../lib/http';
import { uiTexts } from '../../shared/i18n';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('usage-guard');
const text = uiTexts('usage-guard');
const RULES = csvRules(rulesCsv) as {
	threshold: number;
	checkMinutes: number;
	free: { storageGB: number; classA: number; classB: number };
};

/** What R2 bills as class A and B (developers.cloudflare.com/r2/pricing); anything else is free (deletes). */
const CLASS_A = new Set([
	'ListBuckets',
	'PutBucket',
	'ListObjects',
	'PutObject',
	'CopyObject',
	'CompleteMultipartUpload',
	'CreateMultipartUpload',
	'LifecycleStorageTierTransition',
	'ListMultipartUploads',
	'UploadPart',
	'UploadPartCopy',
	'ListParts',
	'PutBucketEncryption',
	'PutBucketCors',
	'PutBucketLifecycleConfiguration',
]);
const CLASS_B = new Set([
	'HeadBucket',
	'HeadObject',
	'GetObject',
	'UsageSummary',
	'GetBucketEncryption',
	'GetBucketLocation',
	'GetBucketCors',
	'GetBucketLifecycleConfiguration',
]);

/** Variables of the deployment (not in every environment's `Env`). */
interface GuardVars {
	CF_API_TOKEN?: string;
	CF_ACCOUNT_ID?: string;
	FILES_BUCKET?: string;
	FILES_BASE_URL?: string;
}
export interface Usage {
	storageGB: number;
	classA: number;
	classB: number;
}
interface State {
	tripped: boolean;
	checkedAt: number;
	usage: Partial<Usage> & { shares?: Partial<Record<keyof Usage, number>>; error?: string };
}

const API = 'https://api.cloudflare.com/client/v4';

/** This month's R2 usage of the account, from the GraphQL analytics (operations since the 1st, storage now). */
export async function r2Usage(token: string, account: string, now: number): Promise<Usage> {
	const d = new Date(now);
	const monthStart = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
	const dayAgo = new Date(now - 86_400_000).toISOString();
	const query = `query R2Usage($account: string!, $start: Time, $end: Time, $dayAgo: Time) {
		viewer {
			accounts(filter: { accountTag: $account }) {
				ops: r2OperationsAdaptiveGroups(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) {
					sum { requests }
					dimensions { actionType }
				}
				storage: r2StorageAdaptiveGroups(limit: 10000, filter: { datetime_geq: $dayAgo, datetime_leq: $end }, orderBy: [datetime_DESC]) {
					max { payloadSize metadataSize }
					dimensions { bucketName datetime }
				}
			}
		}
	}`;
	const res = await fetch(`${API}/graphql`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ query, variables: { account, start: monthStart, end: new Date(now).toISOString(), dayAgo } }),
	});
	const body = (await res.json().catch(() => null)) as {
		data?: {
			viewer?: {
				accounts?: {
					ops: { sum: { requests: number }; dimensions: { actionType: string } }[];
					storage: { max: { payloadSize: number; metadataSize: number }; dimensions: { bucketName: string; datetime: string } }[];
				}[];
			};
		};
		errors?: { message: string }[] | null;
	} | null;
	if (!res.ok || !body || body.errors?.length)
		throw new Error(`R2 analytics: ${res.status} ${body?.errors?.map((e) => e.message).join('; ') ?? ''}`);
	const acc = body.data?.viewer?.accounts?.[0];
	let classA = 0;
	let classB = 0;
	for (const o of acc?.ops ?? []) {
		if (CLASS_A.has(o.dimensions.actionType)) classA += o.sum.requests;
		else if (CLASS_B.has(o.dimensions.actionType)) classB += o.sum.requests;
	}
	// Storage: each bucket's latest size (newest first), summed over the account (the free tier is the account's).
	const latest = new Map<string, number>();
	for (const s of acc?.storage ?? [])
		if (!latest.has(s.dimensions.bucketName)) latest.set(s.dimensions.bucketName, s.max.payloadSize + s.max.metadataSize);
	const bytes = [...latest.values()].reduce((a, b) => a + b, 0);
	return { storageGB: bytes / 1e9, classA, classB };
}

/** Switch the bucket's public custom domain on or off (browsers reach it without the Worker). */
async function publicDomain(token: string, account: string, bucket: string, domain: string, enabled: boolean) {
	const res = await fetch(`${API}/accounts/${account}/r2/buckets/${bucket}/domains/custom/${domain}`, {
		method: 'PUT',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ enabled }),
	});
	if (!res.ok) throw new Error(`R2 custom domain ${domain} ${enabled ? 'on' : 'off'}: ${res.status} ${await res.text()}`);
}

export default definePlugin({
	id: 'usage-guard',
	version: '0.1.0',
	description: 'Pauses the game near a paid limit: R2 beyond its free tier this month',
	dependsOn: ['i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const threshold = ctx.config.define('threshold', {
			description: 'Pause the game when any of R2’s free amounts this month is this far used (0.5 = 50%).',
			default: () => RULES.threshold,
			parse: numberInRange(0.05, 1),
		});
		const checkMinutes = ctx.config.define('checkMinutes', {
			description: 'How often (minutes) the background task asks Cloudflare what R2 used.',
			default: () => RULES.checkMinutes,
			parse: numberInRange(1, 1440),
		});
		const free = ctx.config.define('free', {
			description: 'R2’s free tier a month: storageGB, classA (writes, lists), classB (reads).',
			default: () => RULES.free,
			parse: numberFields(() => RULES.free, 0, 1e12),
		});

		const read = async (db: D1Database): Promise<State> => {
			const row = await db
				.prepare('SELECT tripped, checked_at, usage FROM usage_guard_state WHERE id = 1')
				.first<{ tripped: number; checked_at: number; usage: string }>();
			return row
				? { tripped: !!row.tripped, checkedAt: row.checked_at, usage: JSON.parse(row.usage) }
				: { tripped: false, checkedAt: 0, usage: {} };
		};
		const write = (db: D1Database, s: State) =>
			db
				.prepare(
					'INSERT INTO usage_guard_state (id, tripped, checked_at, usage) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET tripped = excluded.tripped, checked_at = excluded.checked_at, usage = excluded.usage',
				)
				.bind(s.tripped ? 1 : 0, s.checkedAt, JSON.stringify(s.usage))
				.run();
		// Per isolate: whether paused, read again at most once a minute (a request reads no row otherwise).
		let known = { tripped: false, at: -Infinity };
		const paused = async (db: D1Database, now: number) => {
			if (now - known.at >= 60_000) known = { tripped: (await read(db)).tripped, at: now };
			return known.tripped;
		};

		ctx.tasks.add({
			id: 'usage-guard.check',
			always: true,
			async run({ kernel, env, now }) {
				const vars = env as Env & GuardVars;
				if (!vars.CF_API_TOKEN || !vars.CF_ACCOUNT_ID) return;
				const before = await read(env.DB);
				const { values } = await loadConfig(kernel, env);
				const rules = { config: values } as unknown as ReadApi;
				if (now - before.checkedAt < checkMinutes.get(rules) * 60_000) return;
				const limits = free.get(rules);
				let usage: Usage;
				try {
					usage = await r2Usage(vars.CF_API_TOKEN, vars.CF_ACCOUNT_ID, now);
				} catch (err) {
					// Not knowing is no reason to pause (nor to resume): keep the state, try again next time.
					console.error('usage-guard: R2 usage unknown', err);
					await write(env.DB, { ...before, checkedAt: now, usage: { ...before.usage, error: String(err) } });
					return;
				}
				const shares = {
					storageGB: limits.storageGB ? usage.storageGB / limits.storageGB : 0,
					classA: limits.classA ? usage.classA / limits.classA : 0,
					classB: limits.classB ? usage.classB / limits.classB : 0,
				};
				const tripped = Object.values(shares).some((x) => x >= threshold.get(rules));
				if (tripped !== before.tripped) {
					console.warn(`usage-guard: ${tripped ? 'paused' : 'resumed'}`, JSON.stringify({ usage, shares }));
					// Browsers reach the bucket's public domain without the Worker: switched with the game.
					const domain = vars.FILES_BASE_URL ? new URL(vars.FILES_BASE_URL).hostname : '';
					if (domain && vars.FILES_BUCKET)
						await publicDomain(vars.CF_API_TOKEN, vars.CF_ACCOUNT_ID, vars.FILES_BUCKET, domain, !tripped).catch((err) =>
							console.error('usage-guard:', err),
						);
				}
				await write(env.DB, { tripped, checkedAt: now, usage: { ...usage, shares } });
				known = { tripped, at: now };
			},
		});

		ctx.gates.add({
			id: 'usage-guard.pause',
			async check({ env, url }) {
				if (!url.pathname.startsWith('/api/')) return null;
				// The GM (to see why and lift it) and logging in stay open.
				if (url.pathname.startsWith('/api/gm/') || url.pathname.startsWith('/api/auth/')) return null;
				if (!(await paused(env.DB, Date.now()))) return null;
				return errorResponse(fail('paused', 'This month’s free resources are nearly used up: the game is paused until next month.', 503));
			},
			closed: ({ env, now }) => paused(env.DB, now),
		});

		ctx.reports.add({
			id: 'usage-guard.status',
			description:
				'The usage guard: R2 used this month (storage GB, class A and B operations, each as a share of the free tier), whether paused.',
			example: {},
			async run(api) {
				const s = await read(api.db);
				return [
					{
						paused: s.tripped,
						checked: s.checkedAt ? new Date(s.checkedAt).toISOString() : '—',
						storageGB: s.usage.storageGB ?? null,
						classA: s.usage.classA ?? null,
						classB: s.usage.classB ?? null,
						storageShare: s.usage.shares?.storageGB ?? null,
						classAShare: s.usage.shares?.classA ?? null,
						classBShare: s.usage.shares?.classB ?? null,
						error: s.usage.error ?? '',
					},
				];
			},
		});
		ctx.commands.add<Record<string, never>>({
			type: 'usage-guard.resume',
			privileged: true,
			description: 'Lift the pause now; the next check (a minute later) pauses again if R2 is still over the threshold. Payload: {}',
			form: { title: text('Lift the usage pause'), placement: 'gm', fields: [], submitLabel: text('Lift it') },
			parse: shape({}),
			async execute(api) {
				const row = await api.db.prepare('SELECT tripped FROM usage_guard_state WHERE id = 1').first<{ tripped: number }>();
				if (!row?.tripped) throw fail('not_paused', 'The game is not paused');
				// checked_at 0: the next run checks again at once.
				api.write(api.db.prepare('UPDATE usage_guard_state SET tripped = 0, checked_at = 0 WHERE id = 1'));
				known = { tripped: false, at: -Infinity };
			},
		});
	},
});
