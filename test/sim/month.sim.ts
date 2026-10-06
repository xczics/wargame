import { it } from 'vitest';
import { year } from './year';
it('a month (quick check of the year sim)', async () => {
	throw new Error((await year(30)).join('\n'));
});
