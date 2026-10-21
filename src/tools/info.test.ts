import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disk } from '../adapters/disk.ts';
import { info } from './info.ts';
import { build, write } from './test-world.ts';

const dir = mkdtempSync(join(tmpdir(), 'narcissus-'));
const units = build();
let files: string[] = [];
beforeAll(async () => {
	files = await write(dir, units);
});
afterAll(() => rmSync(dir, { recursive: true }));

describe('info', () => {
	it('counts units, and nodes, parents, flat tops and bytes a band', async () => {
		const found = await info(disk, `${dir}/world.json`);
		expect(found.units).toEqual([2, 1]);
		const pages = units.flatMap((unit) => unit.pages);
		const bands = [0, 1, 2, 3, 4, 5].map((g) => {
			const nodes = pages.filter((page) => page.g === g).flatMap((page) => page.nodes);
			return {
				rows: pages.filter((page) => page.g === g).length,
				nodes: nodes.length,
				parents: nodes.filter((node) => node.children).length,
				unary: nodes.filter((node) => node.children === 1).length,
				flat: nodes.filter((node) => node.opacity > 1).length
			};
		});
		expect(found.bands).toHaveLength(bands.length);
		expect(found.bands).toMatchObject(bands);
		expect(bands.map((band) => band.nodes)).toEqual([96, 24, 10, 0, 0, 2]);
		expect(bands[2].unary).toBe(2);
		expect(bands.some((band) => band.flat > 0)).toBe(true);
		const packs = files.filter((path) => path.endsWith('.pack'));
		const bytes = packs.reduce((sum, path) => sum + statSync(join(dir, path)).size, 0);
		expect(found.bytes).toBe(bytes);
		expect(found.bands.every((band) => band.bytes < bytes)).toBe(true);
	});
});
