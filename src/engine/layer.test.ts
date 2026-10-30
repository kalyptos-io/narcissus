import { describe, expect, it } from 'vitest';
import { deflate, encodeLayer, encodePack, encodePage, type Splats } from '../format/encode.ts';
import { boxOf, layerPages } from './layer.ts';

/** n splats at (x, y, z) offsets k metres apart along e */
function splats(n: number, at: readonly [number, number, number]): Splats {
	return {
		count: n,
		position: Float64Array.from({ length: n * 3 }, (_, k) => at[k % 3] + (k % 3 === 0 ? k / 3 : 0)),
		rotation: Float32Array.from({ length: n * 4 }, (_, k) => (k % 4 === 0 ? 1 : 0)),
		scale: new Float32Array(n * 3).fill(Math.log(0.1)),
		alpha: new Float32Array(n).fill(1),
		dc: new Float32Array(n * 3),
		sh: null
	};
}

describe('layerPages', () => {
	it('decodes the pack of encodeLayer with its box in world metres', async () => {
		const { pack, origin } = await encodeLayer(splats(10, [500_000.5, 6_000_000.25, 12]));
		const pages = await layerPages(pack, origin);
		expect(pages).toHaveLength(1);
		expect(pages[0].page.count).toBe(10);
		const [e0, n0, h0, e1, n1, h1] = pages[0].box;
		// the box spans the centres, 0.1 m splats, plus 3 sigma
		expect(e0).toBeCloseTo(500_000.2, 3);
		expect(e1).toBeCloseTo(500_009.8, 3);
		expect([n0, n1]).toEqual([expect.closeTo(5_999_999.95, 3), expect.closeTo(6_000_000.55, 3)]);
		expect([h0, h1]).toEqual([expect.closeTo(11.7, 3), expect.closeTo(12.3, 3)]);
		expect(boxOf(pages.map((p) => p.box))).toEqual({ e: [e0, e1], n: [n0, n1], h: [h0, h1] });
	});

	it('keeps only the finest level of a pack that holds several', async () => {
		const page = async (n: number, g: number) => {
			const { payload, row } = encodePage(splats(n, [1, 1, 0]), { g, i: 0, j: 0 });
			return { row, blob: await deflate(payload) };
		};
		const pack = encodePack([await page(3, 1), await page(5, 0)]);
		const pages = await layerPages(pack, [0, 0]);
		expect(pages.map((p) => p.page.count)).toEqual([5]);
	});
});
