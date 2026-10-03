import { ENGINE_CONFIG } from './config';
import { PluginError } from './errors';
import type {
	Command,
	ConfigDefinition,
	ConfigHandle,
	HookMap,
	MetaProvider,
	Plugin,
	PluginContext,
	Route,
	ServiceLookup,
	ServiceMap,
	Report,
	Task,
	View,
} from './types';

export interface RegisteredConfig {
	key: string;
	/** Plugin id, or "kernel" for engine-level rules. */
	owner: string;
	def: ConfigDefinition<unknown>;
}

export interface CompiledRoute extends Route {
	owner: string;
	pattern: RegExp;
	keys: string[];
}

/** The immutable result of booting a plugin set. One per isolate. */
export interface Kernel {
	plugins: readonly Plugin[];
	services: ServiceLookup;
	hooks: { emit<K extends keyof HookMap>(name: K, payload: HookMap[K]): void };
	commands: ReadonlyMap<string, Command>;
	views: readonly View[];
	reports: ReadonlyMap<string, Report & { owner: string }>;
	tasks: ReadonlyMap<string, Task>;
	routes: readonly CompiledRoute[];
	meta: ReadonlyMap<string, MetaProvider>;
	config: ReadonlyMap<string, RegisteredConfig>;
}

const PLUGIN_ID = /^[a-z][a-z0-9-]*$/;

/** Order plugins so that every plugin comes after its dependencies. Throws on missing deps / cycles. */
export function sortPlugins(plugins: readonly Plugin[]): Plugin[] {
	const byId = new Map<string, Plugin>();
	for (const p of plugins) {
		if (!PLUGIN_ID.test(p.id)) throw new PluginError(`Invalid plugin id "${p.id}" (use kebab-case)`);
		if (byId.has(p.id)) throw new PluginError(`Duplicate plugin id "${p.id}"`);
		byId.set(p.id, p);
	}

	const sorted: Plugin[] = [];
	const state = new Map<string, 'visiting' | 'done'>();
	const visit = (p: Plugin, path: string[]) => {
		const s = state.get(p.id);
		if (s === 'done') return;
		if (s === 'visiting') throw new PluginError(`Plugin dependency cycle: ${[...path, p.id].join(' -> ')}`);
		state.set(p.id, 'visiting');
		for (const dep of p.dependsOn ?? []) {
			const d = byId.get(dep);
			if (!d) throw new PluginError(`Plugin "${p.id}" depends on "${dep}", which is not enabled`);
			visit(d, [...path, p.id]);
		}
		state.set(p.id, 'done');
		sorted.push(p);
	};
	// Visit in declaration order so independent plugins keep a stable, predictable order.
	for (const p of plugins) visit(p, []);
	return sorted;
}

function compilePath(path: string): { pattern: RegExp; keys: string[] } {
	const keys: string[] = [];
	const source = path
		.split('/')
		.map((seg) => {
			if (seg.startsWith(':')) {
				keys.push(seg.slice(1));
				return '([^/]+)';
			}
			return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		})
		.join('/');
	return { pattern: new RegExp(`^${source}$`), keys };
}

export function createKernel(plugins: readonly Plugin[]): Kernel {
	const ordered = sortPlugins(plugins);

	const services = new Map<string, { owner: string; impl: unknown }>();
	const listeners = new Map<string, Array<(payload: never) => void>>();
	const commands = new Map<string, Command & { owner: string }>();
	const views = new Map<string, View & { owner: string }>();
	const reports = new Map<string, Report & { owner: string }>();
	const tasks = new Map<string, Task & { owner: string }>();
	const routes: CompiledRoute[] = [];
	const meta = new Map<string, MetaProvider>();
	const config = new Map<string, RegisteredConfig>();

	const lookup: ServiceLookup = {
		get(name) {
			const s = services.get(name as string);
			if (!s) throw new PluginError(`Service "${String(name)}" is not provided by any enabled plugin`);
			return s.impl as ServiceMap[typeof name];
		},
		has: (name) => services.has(name),
	};

	const hooks: Kernel['hooks'] = {
		emit(name, payload) {
			for (const fn of listeners.get(name) ?? []) (fn as (p: typeof payload) => void)(payload);
		},
	};

	const claim = <T extends { owner: string }>(map: Map<string, T>, kind: string, key: string, value: T) => {
		const existing = map.get(key);
		if (existing) throw new PluginError(`${kind} "${key}" registered by both "${existing.owner}" and "${value.owner}"`);
		map.set(key, value);
	};

	const defineConfig = <T>(owner: string, key: string, def: ConfigDefinition<T>): ConfigHandle<T> => {
		claim(config, 'Config', key, { key, owner, def: def as ConfigDefinition<unknown> });
		return {
			key,
			get(api) {
				if (!(key in api.config)) throw new PluginError(`Config "${key}" missing from snapshot (build it with resolveConfig)`);
				return api.config[key] as T;
			},
		};
	};
	for (const [key, def] of Object.entries(ENGINE_CONFIG)) defineConfig('kernel', key, def);

	let settingUp: string | null = null;
	const ready: { owner: string; fn: () => void }[] = [];
	for (const plugin of ordered) {
		const owner = plugin.id;
		const ctx: PluginContext = {
			pluginId: owner,
			caller: () => settingUp,
			onReady: (fn) => void ready.push({ owner, fn }),
			services: {
				...lookup,
				provide(name, impl) {
					claim(services, 'Service', name as string, { owner, impl });
				},
			},
			hooks: {
				on(name, fn) {
					const list = listeners.get(name) ?? [];
					list.push(fn as (payload: never) => void);
					listeners.set(name, list);
				},
				emit: hooks.emit,
			},
			config: {
				define: (name, def) => defineConfig(owner, `${owner}.${name}`, def),
			},
			commands: { add: (c) => claim(commands, 'Command', c.type, { ...(c as Command), owner }), all: () => commands },
			views: { add: (v) => claim(views, 'View', v.id, { ...v, owner }) },
			reports: { add: (r) => claim(reports, 'Report', r.id, { ...r, owner }) },
			tasks: { add: (t) => claim(tasks, 'Task', t.id, { ...t, owner }) },
			routes: {
				add(route) {
					const key = `${route.method} ${route.path}`;
					const clash = routes.find((r) => `${r.method} ${r.path}` === key);
					if (clash) throw new PluginError(`Route "${key}" registered by both "${clash.owner}" and "${owner}"`);
					routes.push({ ...route, owner, ...compilePath(route.path) });
				},
			},
			meta: {
				add(key, provider) {
					if (meta.has(key)) throw new PluginError(`Meta key "${key}" registered twice`);
					meta.set(key, provider);
				},
			},
		};
		settingUp = owner;
		try {
			plugin.setup(ctx);
		} finally {
			settingUp = null;
		}
	}
	for (const { owner, fn } of ready) {
		settingUp = owner;
		try {
			fn();
		} finally {
			settingUp = null;
		}
	}

	return {
		plugins: ordered,
		services: lookup,
		hooks,
		commands,
		views: [...views.values()],
		reports,
		tasks,
		routes,
		meta,
		config,
	};
}

export function matchRoute(kernel: Kernel, method: string, pathname: string) {
	for (const route of kernel.routes) {
		if (route.method !== method) continue;
		const m = route.pattern.exec(pathname);
		if (!m) continue;
		const params: Record<string, string> = {};
		route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
		return { route, params };
	}
	return null;
}
