// Where the year sim's time goes: each kind of call timed over a few days.
import { it } from 'vitest';
import { year, timing } from './year';
it('profile five days', async () => {
	const t = Date.now();
	await year(60);
	const rows = [...timing].sort((a, b) => b[1].ms - a[1].ms).map(([k, v]) => `${k}: ${v.n} calls, ${Math.round(v.ms)} ms`);
	throw new Error(`total ${Date.now() - t} ms\n${rows.join('\n')}`);
});
