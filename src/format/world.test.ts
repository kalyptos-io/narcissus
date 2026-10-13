import { describe, expect, it } from 'vitest';
import { parseWorld } from './world.ts';

const world = {
	version: 4,
	crs: 'EPSG:25832',
	height: 'DVR90',
	leaf: 250,
	roots: [{ level: 5, e: 720000, n: 6176000, idx: 'u/5/720000/6176000.0123456789abcdef.idx' }],
	extent: { e: [723000, 725000], n: [6177000, 6179000], h: [2.1, 49.9] },
	attribution: { retrieved: '2026-10-03', epoch: 'skraafotos2025' }
};

describe('parseWorld', () => {
	it('accepts a version 4 world', () => {
		expect(parseWorld(JSON.parse(JSON.stringify(world)))).toEqual(world);
	});

	it('rejects another version with a sentence that names the fix', () => {
		expect(() => parseWorld({ ...world, version: 3 })).toThrow(
			'This world is version 3, this viewer reads 4. Rebuild it with the current guldmund.'
		);
	});

	it('rejects missing or malformed fields', () => {
		const root = world.roots[0];
		const bad: unknown[] = [
			null,
			[],
			{ ...world, crs: 'EPSG:4326' },
			{ ...world, leaf: 500 },
			{ ...world, roots: [] },
			{ ...world, roots: [{ ...root, e: 720001 }] },
			{ ...world, roots: [{ ...root, idx: 'u/5/728000/6176000.0123456789abcdef.idx' }] },
			{ ...world, roots: [{ ...root, idx: 'u/5/720000/6176000.0123456789abcdef.pack' }] },
			{ ...world, extent: { ...world.extent, h: [49.9, 2.1] } },
			{ ...world, extent: { ...world.extent, n: [6177000] } },
			{ ...world, attribution: { epoch: 'skraafotos2025' } }
		];
		const sentence = /^This world .+\. Rebuild it with the current guldmund\.$/;
		for (const json of bad) expect(() => parseWorld(json)).toThrow(sentence);
	});
});
