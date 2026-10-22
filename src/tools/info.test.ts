import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { disk } from '../adapters/disk.ts';
import { info } from './info.ts';

const TREE = fileURLToPath(new URL('../../fixtures/tree', import.meta.url));

interface Expected {
	units: { level: number; packSize: number; rows: { g: number; count: number }[] }[];
}

describe('info', () => {
	it('counts the units, pages, splats and pack bytes its writer recorded', async () => {
		const { units } = JSON.parse(readFileSync(`${TREE}/expected.json`, 'utf8')) as Expected;
		const rows = units.flatMap((unit) => unit.rows);
		const levels = [0, 1, 2, 3].map((g) => {
			const at = rows.filter((row) => row.g === g);
			return { pages: at.length, splats: at.reduce((sum, row) => sum + row.count, 0) };
		});
		const found = await info(disk, `${TREE}/world.json`);
		expect(found.units).toEqual([2, 1]);
		expect(found.levels).toEqual(levels);
		expect(found.bytes).toBe(units.reduce((sum, unit) => sum + unit.packSize, 0));
		expect(found.world.roots).toHaveLength(1);
	});
});
