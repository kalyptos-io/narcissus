import { describe, expect, it } from 'vitest';
import { directory, parseWorld } from './world.ts';

const world = {
	version: 1,
	crs: 'EPSG:25832',
	height: 'DVR90',
	leaf: 250,
	roots: [{ level: 5, e: 720000, n: 6176000, idx: 'u/5/720000/6176000.0123456789abcdef.idx' }],
	extent: { e: [723000, 725000], n: [6177000, 6179000], h: [2.1, 49.9] }
};

describe('parseWorld', () => {
	it('accepts a version 1 world', () => {
		expect(parseWorld(JSON.parse(JSON.stringify(world)))).toEqual({
			...world,
			attributes: {},
			extra: {}
		});
	});

	it('takes any coordinate system and height datum as labels', () => {
		const { crs, height } = parseWorld({ ...world, crs: 'EPSG:32633', height: 'EGM2008' });
		expect([crs, height]).toEqual(['EPSG:32633', 'EGM2008']);
	});

	it('keeps the members it does not know in extra', () => {
		const source = { name: 'survey', retrieved: '2026-10-03' };
		const { extra } = parseWorld({ ...world, source, waiting: [] });
		expect(extra).toEqual({ source, waiting: [] });
	});

	it('reads the declared attribute streams, a number default given to every component', () => {
		const attributes = {
			'test.class': { type: 'u16', components: 1, default: 0, rule: 'preserved' },
			'test.tone': { type: 'f16', components: 2, default: [0.5, 1], rule: 'aggregated' },
			'test.parts': { type: 'records', rule: 'unavailable' }
		};
		expect(parseWorld({ ...world, attributes }).attributes).toEqual({
			'test.class': { type: 'u16', components: 1, default: [0], rule: 'preserved' },
			'test.tone': { type: 'f16', components: 2, default: [0.5, 1], rule: 'aggregated' },
			'test.parts': { type: 'records', components: 0, default: [], rule: 'unavailable' }
		});
		expect(
			parseWorld({
				...world,
				attributes: { 'a.b': { type: 'i8', components: 3, default: -2, rule: 'preserved' } }
			}).attributes['a.b'].default
		).toEqual([-2, -2, -2]);
	});

	it('rejects an attribute stream it cannot store', () => {
		const ok = { type: 'u8', components: 1, default: 0, rule: 'preserved' };
		const bad: [string, unknown][] = [
			['plain', ok],
			['a.', ok],
			['a b.c', ok],
			['a.' + 'b'.repeat(254), ok],
			['a.b', { ...ok, type: 'u64' }],
			['a.b', { ...ok, components: 5 }],
			['a.b', { ...ok, components: 0 }],
			['a.b', { ...ok, default: 256 }],
			['a.b', { ...ok, default: 1.5 }],
			['a.b', { ...ok, components: 2, default: [1] }],
			['a.b', { ...ok, rule: 'majority' }],
			['a.b', { type: 'records', components: 1, rule: 'preserved' }],
			['a.b', { type: 'records', default: 0, rule: 'preserved' }]
		];
		for (const [name, declared] of bad) {
			expect(() => parseWorld({ ...world, attributes: { [name]: declared } }), name).toThrow(
				`This world has an invalid attribute ${name}.`
			);
		}
		expect(() => parseWorld({ ...world, attributes: [] })).toThrow('an invalid attributes member');
	});

	it('rejects another version with a sentence that names both', () => {
		expect(() => parseWorld({ ...world, version: 3 })).toThrow(
			'This world is version 3; narcissus reads 1.'
		);
	});

	it('rejects missing or malformed fields', () => {
		const root = world.roots[0];
		const bad: unknown[] = [
			null,
			[],
			{ ...world, crs: '' },
			{ ...world, height: undefined },
			{ ...world, leaf: 500 },
			{ ...world, roots: [] },
			{ ...world, roots: [{ ...root, e: 720001 }] },
			{ ...world, roots: [{ ...root, idx: 'u/5/728000/6176000.0123456789abcdef.idx' }] },
			{ ...world, roots: [{ ...root, idx: 'u/5/720000/6176000.0123456789abcdef.pack' }] },
			{ ...world, extent: { ...world.extent, h: [49.9, 2.1] } },
			{ ...world, extent: { ...world.extent, n: [6177000] } }
		];
		for (const json of bad) expect(() => parseWorld(json)).toThrow(/^This world has .+\.$/);
	});
});

describe('directory', () => {
	it('cuts a world url back to its directory without the query', () => {
		const url = 'https://host.example/t/abc/world.json?v=2';
		expect(directory(url)).toBe('https://host.example/t/abc/');
	});
});
