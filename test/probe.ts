/**
 * Running test code inside the engine, as a view would (reads only, the call's memo shared): for checks on what
 * the services work out where no view sends it whole. The kernel gets a test plugin with one view that runs the
 * function it is handed (a copy of the kernel, kept per kernel; the database is the same).
 */
import { env } from 'cloudflare:workers';
import { computeViews, createKernel, definePlugin, type EngineApi, type EngineContext, type Kernel } from '../src/kernel';

const pending = new Map<string, (api: EngineApi) => Promise<unknown>>();
const probed = new WeakMap<Kernel, Kernel>();

const probePlugin = definePlugin({
	id: 'test-probe',
	version: '0',
	setup(ctx) {
		ctx.views.add({
			id: 'test-probe.run',
			compute: (api, params) => {
				const run = pending.get(params.probe ?? '');
				if (!run) throw new Error('no such probe');
				return run(api);
			},
		});
	},
});

/** Run `fn` in the engine for the context's player, with `params` as a view gets them (on `db`: e.g. one counting queries). */
export async function probe<T>(
	kernel: Kernel,
	ctx: EngineContext,
	fn: (api: EngineApi, kernel: Kernel) => Promise<T>,
	params: Record<string, string> = {},
	db: D1Database = env.DB,
): Promise<T> {
	let k = probed.get(kernel);
	if (!k) probed.set(kernel, (k = createKernel([...kernel.plugins, probePlugin])));
	const id = crypto.randomUUID();
	pending.set(id, (api) => fn(api, k));
	try {
		const { views } = await computeViews(k, db, ctx, ['test-probe.run'], { ...params, probe: id });
		return views['test-probe.run'] as T;
	} finally {
		pending.delete(id);
	}
}

/** A view of the probing kernel worked out in the same call (sharing its memo). */
export const viewIn = <T>(kernel: Kernel, api: EngineApi, id: string, params: Record<string, string>) =>
	kernel.views.find((v) => v.id === id)!.compute(api, params) as Promise<T>;
/** A static view of the kernel under the call's rules. */
export const staticIn = async <T>(kernel: Kernel, api: EngineApi, id: string) =>
	(await kernel.statics.find((v) => v.id === id)!.compute({ rules: api as never, db: api.db })) as T;
