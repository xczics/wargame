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

/* ----- pictures the GM uploads (puzzles, the site's icon...): checked by their bytes, stored under their hash ----- */

export type ImageType = 'webp' | 'png' | 'jpg' | 'svg' | 'ico';
export const IMAGE_CONTENT_TYPES: Record<ImageType, string> = {
	webp: 'image/webp',
	png: 'image/png',
	jpg: 'image/jpeg',
	svg: 'image/svg+xml',
	ico: 'image/x-icon',
};

/** A picture's type by its first bytes (never by what the request says), if it is one of `allowed`. */
export function sniffImage<T extends ImageType>(b: Uint8Array, allowed: readonly T[]): T | null {
	const at = (i: number, ...bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
	let type: ImageType | null = null;
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) type = 'webp';
	else if (at(0, 0x89, 0x50, 0x4e, 0x47)) type = 'png';
	else if (at(0, 0xff, 0xd8, 0xff)) type = 'jpg';
	// An icon directory of 1-255 pictures: reserved 0, type 1, then the count.
	else if (at(0, 0, 0, 1, 0) && b[4] > 0 && b[5] === 0) type = 'ico';
	// SVG is text: its root element first (after an XML declaration, comments, a DOCTYPE — refused later — and white space;
	// the decoder drops a byte order mark).
	else if (
		/^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>\s*)*<svg[\s>]/.test(
			new TextDecoder().decode(b.subarray(0, 2048)),
		)
	)
		type = 'svg';
	return type && (allowed as readonly ImageType[]).includes(type) ? (type as T) : null;
}

/**
 * Whether an SVG could do more than draw itself: scripts, event handlers, embedded documents, entities, references to
 * anything outside the file. Such files are refused, not cleaned (no parser here to clean them reliably): an uploaded
 * SVG may be opened on its own, from the bucket's public domain too, where no response header of ours protects it.
 */
export function unsafeSvg(bytes: Uint8Array): boolean {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return true;
	}
	return [
		/<\s*(script|foreignObject|iframe|embed|object|audio|video|handler|listener)\b/i,
		/<!(ENTITY|DOCTYPE)/i,
		/<\?xml-stylesheet/i,
		/\son[a-z]+\s*=/i,
		/javascript:|vbscript:|data:(?!image\/(png|jpeg|webp|gif);base64,)/i,
		// Links and references only to the file's own elements ("#id").
		/\s(xlink:)?href\s*=(?!\s*["']?\s*#)/i,
		/url\((?!\s*["']?\s*#)/i,
		/attributeName\s*=\s*["']?\s*(xlink:)?href/i,
		/@import/i,
	].some((re) => re.test(text));
}

/** Store a picture in the bucket under its content's hash (`<prefix>/<20 hex>.<type>`), kept by browsers for good. */
export async function putImage(bucket: R2Bucket, prefix: string, bytes: Uint8Array, type: ImageType): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
	const key = `${prefix}/${[...digest.slice(0, 10)].map((b) => b.toString(16).padStart(2, '0')).join('')}.${type}`;
	await bucket.put(key, bytes, {
		httpMetadata: { contentType: IMAGE_CONTENT_TYPES[type], cacheControl: 'public, max-age=31536000, immutable' },
	});
	return key;
}

/** The name part of keys `putImage` makes ("<20 hex>.<type>"), for the routes that serve them. */
export const imageName = (types: readonly ImageType[]) => new RegExp(`^[0-9a-f]{20}\\.(${types.join('|')})$`);

/**
 * A stored picture as a response (`cache`: its Cache-Control). An SVG opened on its own runs sandboxed, with nothing
 * allowed but its own styles and embedded pictures, whatever might have slipped past `unsafeSvg`.
 */
export function imageResponse(file: R2ObjectBody, cache: string): Response {
	const headers = new Headers();
	file.writeHttpMetadata(headers);
	headers.set('cache-control', cache);
	headers.set('x-content-type-options', 'nosniff');
	if (headers.get('content-type')?.startsWith('image/svg'))
		headers.set('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
	return new Response(file.body, { headers });
}
