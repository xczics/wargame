/** The usage log (src/runtime/usage.ts): off unless asked for; counts rows and requests; one line per ended period. */
import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { flushUsage, meterRequest, usageLine, usageMinutes } from '../src/runtime/usage';

const table = () => env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_periods'").first();

describe('usage log', () => {
	it('is off by default: the database is not wrapped and no table is made', async () => {
		expect(usageMinutes(env)).toBe(0);
		expect(meterRequest(env, new URL('http://x/api/state'))).toBe(env);
		await flushUsage(env, Date.now());
		expect(await table()).toBeNull();
	});

	it('when on: counts requests and rows, keeps them per period (4 hours by default) and logs ended periods', async () => {
		const on = { ...env, USAGE_LOG: 'on' } as Env;
		expect(usageMinutes(on)).toBe(240);
		expect(usageMinutes({ ...env, USAGE_LOG: '30' } as Env)).toBe(30);
		const t0 = Date.UTC(2030, 0, 1);
		const metered = meterRequest(on, new URL('http://x/api/command'));
		await metered.DB.prepare('SELECT 1 AS one').first();
		await metered.DB.batch([metered.DB.prepare("INSERT INTO engine_locks (entity, version) VALUES ('usage-test', 1)")]);
		await flushUsage(on, t0);
		const row = await env.DB.prepare('SELECT * FROM usage_periods WHERE start = ?').bind(t0).first<Record<string, number>>();
		expect(row).toMatchObject({ requests: 1, commands: 1, minutes: 240, logged: 0 });
		expect(row!.rows_written).toBeGreaterThan(0);
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		await flushUsage(on, t0 + 240 * 60_000); // the next period: the first is logged
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(log.mock.calls[0][0] as string).usage).toMatchObject({ requests: 1, commands: 1, minutes: 240 });
		log.mockRestore();
		expect(
			usageLine({ start: t0, requests: 600, commands: 0, rows_read: 0, rows_written: 0, cpu_ms: 1200, db_bytes: 0 }, 240).perDay.requests,
		).toBe(3600);
	});
});
