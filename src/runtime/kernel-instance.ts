import { createKernel, type Kernel } from '../kernel';
import { plugins } from '../plugins';

let kernel: Kernel | undefined;

/** The kernel for this isolate, booted once on first use (Worker and Durable Object share it). */
export function getKernel(): Kernel {
	kernel ??= createKernel(plugins);
	return kernel;
}
