/**
 * Queues: work that waits its turn at a settlement — troops trained in a barracks, defences built at the
 * wall. A kind of work (registered by the plugin that owns it) has lines (one per barracks type, one wall);
 * each line runs one job at a time and the others wait in order.
 *
 * Every job is paid when it is added: what waits cannot be plundered, and cancelling a job that has not
 * started gives its cost back. A job's time is worked out when it starts (bonuses as they are then); when
 * it finishes (the timeline, at the exact moment) the owner's `finish` applies it and the next one starts.
 * How many may wait in a line is the stat `queues.waiting` of the settlement (rule `queues.maxWaiting`).
 */
import { csvRules, definePlugin, type EngineApi, gameErrors, numberInRange, PluginError, type ReadApi } from '../../kernel';
import { uiTexts } from '../../shared/i18n';
import type { Cost } from '../resources';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

const RULES = csvRules(rulesCsv) as { maxWaiting: number };
const text = uiTexts('queues');
const fail = gameErrors('queues');
const DONE = 'queues.done';

export interface QueueJob<P = unknown> {
	id: string;
	kind: string;
	/** The settlement it runs at. */
	owner: string;
	line: string;
	/** Order within the settlement (lines share it). */
	seq: number;
	/** What the owner of the kind keeps about it (e.g. the unit and how many). */
	payload: P;
	/** What was paid: refunded if it is cancelled before it starts. */
	cost: Cost;
	startedAt: number | null;
	finishesAt: number | null;
}

/** A kind of queued work, registered by the plugin that owns it. Its id: "<pluginId>.<name>". */
export interface QueueKind<P> {
	id: string;
	/** Seconds the job takes, worked out when it starts. Must only read. */
	seconds(api: EngineApi, job: QueueJob<P>): Promise<number>;
	/** It is done (inside the timeline, at `at`): apply it with `api.write`. */
	finish(api: EngineApi, job: QueueJob<P>, at: number): Promise<void>;
}

export interface QueuesService {
	define<P>(kind: QueueKind<P>): void;
	/** The jobs of a kind at a settlement, in order (due ones finished first). */
	jobs<P>(api: EngineApi, kind: string, owner: string): Promise<QueueJob<P>[]>;
	/**
	 * Pay `cost` from the settlement and add a job at the end of `line`; it starts at once when the line is
	 * idle. Refused when the line already has as many waiting as `queues.waiting` allows.
	 */
	add<P>(api: EngineApi, kind: string, owner: string, line: string, payload: P, cost: Cost): Promise<QueueJob<P>>;
	/** Cancel a job that has not started: its cost comes back. Returns it. */
	cancel<P>(api: EngineApi, kind: string, owner: string, id: string): Promise<QueueJob<P>>;
	/** Take `seconds` off the running job of `line` (or the one finishing soonest). False when nothing runs. */
	speedUp(api: EngineApi, kind: string, owner: string, seconds: number, line?: string): Promise<boolean>;
	/**
	 * Take over jobs kept elsewhere before this plugin (an owner's old queue table): as they were, running
	 * ones finishing when they would have. The owner deletes its old rows and cancels its old events.
	 */
	adopt(api: EngineApi, kind: string, owner: string, jobs: Omit<QueueJob, 'kind' | 'owner' | 'seq'>[]): Promise<void>;
}

declare module '../../kernel' {
	interface ServiceMap {
		queues: QueuesService;
	}
}

export default definePlugin({
	id: 'queues',
	version: '0.1.0',
	description:
		'Jobs waiting their turn at a settlement: paid up front, run one at a time per line, refunded if cancelled before they start',
	dependsOn: ['settlements', 'resources', 'stats', 'timeline', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const kinds = new Map<string, QueueKind<unknown>>();

		const maxWaiting = ctx.config.define('maxWaiting', {
			description: 'Jobs that may wait in one line (a barracks, the wall) behind the one running, before bonuses (stat queues.waiting).',
			default: () => RULES.maxWaiting,
			parse: numberInRange(0, 1000),
		});
		stats.define({
			id: 'queues.waiting',
			description: text('jobs waiting per line'),
			base: (api) => maxWaiting.get(api),
			integer: true,
			min: 0,
		});

		const kindOf = (id: string) => {
			const k = kinds.get(id);
			if (!k) throw new PluginError(`Unknown queue kind "${id}"`);
			return k;
		};
		/** Every job at a settlement, all kinds, in order. Changes in a command are kept here. */
		const load = (api: ReadApi, owner: string) =>
			api.memo(`queues:${owner}`, async () => {
				const { results } = await api.db.prepare('SELECT * FROM queues_jobs WHERE owner = ? ORDER BY seq').bind(owner).all<{
					id: string;
					kind: string;
					owner: string;
					line: string;
					seq: number;
					payload: string;
					cost: string;
					started_at: number | null;
					finishes_at: number | null;
				}>();
				return results.map((r): QueueJob => ({
					id: r.id,
					kind: r.kind,
					owner: r.owner,
					line: r.line,
					seq: r.seq,
					payload: JSON.parse(r.payload),
					cost: JSON.parse(r.cost),
					startedAt: r.started_at,
					finishesAt: r.finishes_at,
				}));
			});
		const insert = (api: EngineApi, j: QueueJob) =>
			api.write(
				api.db
					.prepare(
						'INSERT INTO queues_jobs (id, kind, owner, line, seq, payload, cost, started_at, finishes_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
					)
					.bind(j.id, j.kind, j.owner, j.line, j.seq, JSON.stringify(j.payload), JSON.stringify(j.cost), j.startedAt, j.finishesAt),
			);
		/** Start a waiting job at `at`: its time is worked out now. */
		async function start(api: EngineApi, j: QueueJob, at: number) {
			const seconds = await kindOf(j.kind).seconds(api, j);
			j.startedAt = at;
			j.finishesAt = at + Math.max(1, Math.ceil(seconds)) * 1000;
			api.write(
				api.db.prepare('UPDATE queues_jobs SET started_at = ?, finishes_at = ? WHERE id = ?').bind(j.startedAt, j.finishesAt, j.id),
			);
			timeline.schedule(api, settlements.entity(j.owner), j.finishesAt, DONE, { owner: j.owner, id: j.id });
		}
		const sameLine = (a: QueueJob, b: QueueJob) => a.kind === b.kind && a.line === b.line;

		timeline.on<{ owner: string; id: string }>(DONE, async (api, event) => {
			const all = await load(api, event.payload.owner);
			const i = all.findIndex((j) => j.id === event.payload.id);
			// Gone (cancelled) or moved later than this event (an old one left after a change): nothing to do.
			if (i < 0 || all[i].finishesAt === null || all[i].finishesAt! > event.dueAt) return;
			const [done] = all.splice(i, 1);
			api.write(api.db.prepare('DELETE FROM queues_jobs WHERE id = ?').bind(done.id));
			await kindOf(done.kind).finish(api, done, event.dueAt);
			// The next one in this line starts at once.
			const next = all.find((j) => sameLine(j, done) && j.startedAt === null);
			if (next) await start(api, next, event.dueAt);
		});

		const service: QueuesService = {
			define(kind) {
				if (kinds.has(kind.id)) throw new PluginError(`Queue kind "${kind.id}" defined twice`);
				kinds.set(kind.id, kind as QueueKind<unknown>);
			},
			async jobs<P>(api: EngineApi, kind: string, owner: string) {
				kindOf(kind);
				await timeline.sync(api, settlements.entity(owner));
				return (await load(api, owner)).filter((j) => j.kind === kind) as QueueJob<P>[];
			},
			async add<P>(api: EngineApi, kind: string, owner: string, line: string, payload: P, cost: Cost) {
				kindOf(kind);
				const holder = settlements.entity(owner);
				await timeline.sync(api, holder);
				const all = await load(api, owner);
				const inLine = all.filter((j) => j.kind === kind && j.line === line);
				const waiting = inLine.filter((j) => j.startedAt === null).length;
				const limit = await stats.get(api, 'queues.waiting', holder);
				// The running one does not count: an idle line takes a job even at limit 0.
				if (inLine.length && waiting >= limit) throw fail('queue_full', text('At most {0} waiting here', { 0: limit }));
				await resources.spend(api, holder, cost);
				const job: QueueJob<P> = {
					id: crypto.randomUUID(),
					kind,
					owner,
					line,
					seq: Math.max(0, ...all.map((j) => j.seq)) + 1,
					payload,
					cost,
					startedAt: null,
					finishesAt: null,
				};
				all.push(job);
				insert(api, job);
				if (!inLine.some((j) => j.startedAt !== null)) await start(api, job, api.now);
				return job;
			},
			async cancel<P>(api: EngineApi, kind: string, owner: string, id: string) {
				const holder = settlements.entity(owner);
				await timeline.sync(api, holder); // it may have started meanwhile
				const all = await load(api, owner);
				const i = all.findIndex((j) => j.id === id && j.kind === kind);
				if (i < 0) throw fail('not_found', 'No such job', 404);
				if (all[i].startedAt !== null) throw fail('blocked', 'This one has started already');
				const [job] = all.splice(i, 1);
				api.write(api.db.prepare('DELETE FROM queues_jobs WHERE id = ?').bind(job.id));
				await resources.refund(api, holder, job.cost);
				return job as QueueJob<P>;
			},
			async speedUp(api, kind, owner, seconds, line) {
				const holder = settlements.entity(owner);
				await timeline.sync(api, holder); // what is due first
				const j = (await load(api, owner))
					.filter((x) => x.kind === kind && x.finishesAt !== null && (line === undefined || x.line === line))
					.sort((a, b) => a.finishesAt! - b.finishesAt!)[0];
				if (!j) return false;
				j.finishesAt = Math.max(api.now, j.finishesAt! - seconds * 1000);
				api.write(api.db.prepare('UPDATE queues_jobs SET finishes_at = ? WHERE id = ?').bind(j.finishesAt, j.id));
				timeline.cancelWhere(api, holder, DONE, { id: j.id });
				timeline.schedule(api, holder, j.finishesAt, DONE, { owner, id: j.id });
				await timeline.sync(api, holder);
				return true;
			},
			async adopt(api, kind, owner, jobs) {
				kindOf(kind);
				const all = await load(api, owner);
				let seq = Math.max(0, ...all.map((j) => j.seq));
				for (const j of jobs) {
					const job: QueueJob = { ...j, kind, owner, seq: ++seq };
					all.push(job);
					insert(api, job);
					if (job.finishesAt !== null) timeline.schedule(api, settlements.entity(owner), job.finishesAt, DONE, { owner, id: job.id });
				}
			},
		};
		ctx.services.provide('queues', service);
	},
});
