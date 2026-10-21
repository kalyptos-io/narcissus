import { describe, expect, it } from 'vitest';
import { contentName, encodePack, encodePage, link, type Nodes } from './encode.ts';
import { rowAt } from './idx.ts';
import { deflate, inflate } from './inflate.ts';
import { linkRow, linkStart, linkUnit, pageHeader } from './page.ts';
import { PAGE_SIDE, ROW_BYTES } from './spec.ts';

/** n fit splats spread over page (g, i, j) */
function splats(n: number, page: { g: number; i: number; j: number }): Nodes {
	const side = PAGE_SIDE * 2 ** page.g;
	const r = (k: number) => Math.abs(Math.sin(k * 12.9898) * 43758.5453) % 1;
	const corner = [page.i * side, page.j * side, 0];
	return {
		count: n,
		position: Float64Array.from({ length: n * 3 }, (_, k) => corner[k % 3] + r(k) * side),
		rotation: Float32Array.from({ length: n * 4 }, (_, k) => (k % 4 === 0 ? 1 : 0)),
		scale: Float32Array.from({ length: n * 3 }, (_, k) => -3 + r(k + 7)),
		opacity: Float32Array.from({ length: n }, (_, k) => r(k + 11)),
		dc: Float32Array.from({ length: n * 3 }, (_, k) => r(k + 13) - 0.5),
		sh: Float32Array.from({ length: n * 9 }, (_, k) => 0.1 * r(k + 17)),
		children: new Uint8Array(n),
		links: new Uint32Array(n)
	};
}

describe('encodePack', () => {
	it('lays out blobs, the page table and the trailer as format.md says', async () => {
		const keys = [
			{ g: 1, i: 0, j: 0 },
			{ g: 1, i: 1, j: 0 }
		];
		const pages = await Promise.all(
			keys.map(async (key, k) => {
				const { payload, row } = encodePage(splats(50 + 20 * k, key), key);
				return { row, blob: await deflate(payload) };
			})
		);
		const pack = encodePack(pages, 120);
		const view = new DataView(pack.buffer);
		const end = pack.length;
		const table = view.getUint32(end - 16, true);
		expect(view.getUint32(end - 20, true)).toBe(120);
		expect(table).toBe(pages[0].blob.length + pages[1].blob.length);
		expect(view.getUint32(end - 12, true)).toBe(2);
		expect(new TextDecoder().decode(pack.subarray(end - 8, end - 4))).toBe('GMPK');
		expect([view.getUint16(end - 4, true), view.getUint16(end - 2, true)]).toEqual([2, 0]);
		expect(end).toBe(table + 2 * ROW_BYTES + 20);
		for (const [k, { row, blob }] of pages.entries()) {
			expect(rowAt(view, table + k * ROW_BYTES)).toEqual(row);
			const stored = pack.subarray(row.offset, row.offset + row.length);
			expect(stored).toEqual(blob);
			const payload = await inflate(stored);
			expect(pageHeader(payload)).toEqual({ count: row.count, parents: 0 });
		}
	});
});

describe('link', () => {
	it('packs start, row and unit into the bits format.md gives them', () => {
		const packed = link(4, 300, 0xabcde);
		expect(packed).toBe((4 * 2 ** 29 + 300 * 2 ** 20 + 0xabcde) >>> 0);
		expect([linkUnit(packed), linkRow(packed), linkStart(packed)]).toEqual([4, 300, 0xabcde]);
		expect([linkUnit(link(0, 511, 0xfffff)), linkRow(link(7, 0, 0))]).toEqual([0, 0]);
	});
});

describe('contentName', () => {
	it('is 64-bit fnv-1a as 16 hex digits', () => {
		const name = (text: string) => contentName(new TextEncoder().encode(text));
		expect(name('')).toBe('cbf29ce484222325');
		expect(name('a')).toBe('af63dc4c8601ec8c');
		expect(name('foobar')).toBe('85944171f73967e8');
	});
});
