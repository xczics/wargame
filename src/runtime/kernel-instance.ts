import pkg from '../../package.json';
import { createKernel, resolveConfig, type Kernel } from '../kernel';
import { plugins } from '../plugins';

// Booted while the module loads (the isolate's startup, its own 1 s budget), not inside the first request or cron run,
// which have 10 ms of CPU on the free plan: assembling the plugins and working out every rule's default once is more
// than that (measured 2026-10-19: 75 ms on a fresh isolate's first request, 122 ms on a cron run).
const kernel: Kernel = createKernel(plugins, { build: pkg.version });
resolveConfig(kernel, {}); // fills the rules' cache: a request with no GM overrides of a rule reuses its default

/** The kernel for this isolate (Worker and Durable Object share it). */
export function getKernel(): Kernel {
	return kernel;
}
