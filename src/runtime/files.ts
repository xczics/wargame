/** The deployment's file bucket (R2 binding FILES) as the kernel's `FileStore`; emulated locally and in Docker. */
import type { FileStore } from '../kernel';

const stores = new WeakMap<R2Bucket, FileStore>();

export function bucketFiles(bucket: R2Bucket): FileStore {
	let store = stores.get(bucket);
	if (!store)
		stores.set(
			bucket,
			(store = {
				get: async (key) => (await bucket.get(key))?.text() ?? null,
				put: async (key, body, options = {}) =>
					void (await bucket.put(key, body, {
						httpMetadata: {
							...(options.contentType ? { contentType: options.contentType } : {}),
							...(options.cacheControl ? { cacheControl: options.cacheControl } : {}),
						},
					})),
			}),
		);
	return store;
}

/** The bucket of this deployment, if it has one. */
export const envFiles = (env: Env): FileStore | undefined => (env.FILES ? bucketFiles(env.FILES) : undefined);
