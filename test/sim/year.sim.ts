// A year, four visits a day (test/sim/year.ts). Takes about an hour and a half.
import { describe, it } from 'vitest';
import { year } from './year';

describe('a year', () => {
	it(
		'four visits a day',
		async () => {
			throw new Error((await year()).join('\n'));
		},
		3 * 3600_000,
	);
});
