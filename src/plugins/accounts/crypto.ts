// Password hashing and token helpers on WebCrypto (available in Workers without Node compat).

// workerd caps PBKDF2 at 100k iterations.
const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

function toBase64(bytes: ArrayBuffer | Uint8Array): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)));
}

function fromBase64(b64: string): Uint8Array {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function randomToken(bytes = 32): string {
	return toBase64(crypto.getRandomValues(new Uint8Array(bytes)))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

// Per isolate: a session token is hashed on every request it makes (the same input, the same hash).
const hashed = new Map<string, Promise<string>>();
export function sha256(input: string): Promise<string> {
	let out = hashed.get(input);
	if (!out) {
		if (hashed.size >= 1000) hashed.clear();
		out = crypto.subtle.digest('SHA-256', encoder.encode(input)).then(toBase64);
		hashed.set(input, out);
		out.catch(() => hashed.delete(input));
	}
	return out;
}

async function pbkdf2(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
	const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
	return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITERATIONS }, key, 256);
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	return { hash: toBase64(await pbkdf2(password, salt)), salt: toBase64(salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
	if (!hash || !salt) return false;
	const actual = new Uint8Array(await pbkdf2(password, fromBase64(salt)));
	const expected = fromBase64(hash);
	return actual.length === expected.length && crypto.subtle.timingSafeEqual(actual, expected);
}

/** Constant-time string comparison (compares digests so lengths always match). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
	const [da, db] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', encoder.encode(s))));
	return crypto.subtle.timingSafeEqual(da, db);
}
