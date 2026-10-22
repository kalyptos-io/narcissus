import { describe, expect, it } from 'vitest';
import type { Idx } from './types.ts';
import { encodeIdx, wrap } from './encode.ts';
import { parseIdx, parseUnitPath, unitPath } from './idx.ts';
import { IDX_MAGIC } from './spec.ts';

const idx: Idx = {
	level: 1,
	e: 724000,
	n: 6177500,
	pack: '0123456789abcdef',
	packSize: 123456,
	col: 'fedcba9876543210',
	rows: [
		{
			g: 2,
			i: 0,
			j: 1,
			count: 1000,
			quadrants: [200, 500, 700],
			box: Float32Array.of(1.5, 126.25, -3, 124, 249.5, 30.75),
			offset: 0,
			length: 4000
		},
		{
			g: 2,
			i: 1,
			j: 1,
			count: 7,
			quadrants: [0, 7, 7],
			box: Float32Array.of(125, 125, 2, 250, 250, 4),
			offset: 4000,
			length: 90
		}
	],
	children: [
		{ quadrant: 0, idx: '00000000000000ff' },
		{ quadrant: 3, idx: 'a0a1a2a3a4a5a6a7' }
	],
	descendants: [
		{ depth: 2, column: 3, row: 1, idx: '1111111111111111' },
		{ depth: 3, column: 7, row: 6, idx: '2222222222222222' }
	]
};

describe('parseIdx', () => {
	it('reads back what encodeIdx wrote', async () => {
		expect(await parseIdx(await encodeIdx(idx))).toEqual(idx);
	});

	it('reads an all-zero colour hash as no colour', async () => {
		const plain = { ...idx, col: null, children: [], descendants: [] };
		expect(await parseIdx(await encodeIdx(plain))).toEqual(plain);
	});

	it('rejects a body whose counts do not match its size', async () => {
		const body = new Uint8Array(40);
		new DataView(body.buffer).setUint16(32, 1, true);
		await expect(parseIdx(await wrap(body, IDX_MAGIC))).rejects.toThrow(
			'.idx holds 40 bytes, its counts need 92'
		);
	});
});

describe('unitPath', () => {
	it('names unit files by level, corner and hash', () => {
		const key = { level: 0, e: 724250, n: 6177750 };
		const path = unitPath(key, 'ab'.repeat(8), 'pack');
		expect(path).toBe('u/0/724250/6177750.abababababababab.pack');
		expect(parseUnitPath(path)).toEqual({ ...key, hash: 'ab'.repeat(8) });
		expect(parseUnitPath(`tiles/${unitPath(key, '0'.repeat(16), 'idx')}`)).toEqual({
			...key,
			hash: '0'.repeat(16)
		});
	});

	it('refuses paths that are not unit files', () => {
		expect(parseUnitPath('u/0/724250/6177750.ABABABABABABABAB.idx')).toBeNull();
		expect(parseUnitPath('u/0/724250/6177750.abababab.idx')).toBeNull();
		expect(parseUnitPath('u/0/724250/6177750.abababababababab.json')).toBeNull();
		expect(parseUnitPath('world.json')).toBeNull();
	});
});
