// Every table the migrations create belongs to exactly one plugin that says so (`Plugin.tables`), and every table a
// plugin says it owns is there: the kernel then knows whose each table is (relations, `tablesOf`, the static check).
import { describe, expect, it } from 'vitest';
import { db, defaultKernel } from './helpers';

describe('tables', () => {
	it("the plugins' tables are exactly the migrated ones (the engine's own aside)", async () => {
		const { results } = await db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
			)
			.all<{ name: string }>();
		const migrated = results.map((r) => r.name).filter((t) => !t.startsWith('engine_'));
		expect([...defaultKernel.tables.keys()].sort()).toEqual(migrated.sort());
	});
});
