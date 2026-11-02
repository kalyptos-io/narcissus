import { describe, expect, it } from 'vitest';
import { CLUSTER } from '../format/index.ts';
import { deflate, encodeLayer, encodePack, encodePage, type Splats } from '../format/encode.ts';
import { Pool } from './gpu/pool.ts';
import { testDevice } from './gpu/test-device.ts';
import { boxOf, layerPages, Layers } from './layer.ts';

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

describe('Layers', () => {
	const none = () => false;

	/** a pool of four clusters, layers over it and the count of their changes */
	async function setup() {
		const pool = new Pool(await testDevice(), 4 * CLUSTER);
		const changes = { count: 0 };
		const layers = new Layers(pool, none, () => changes.count++);
		const { pack, origin } = await encodeLayer(splats(10, [500_000.5, 6_000_000.25, 12]));
		const pages = await layerPages(pack, origin);
		return { pool, layers, changes, add: () => layers.add(pages, origin)! };
	}

	it('pins its pages in the pool and draws them at its opacity while visible', async () => {
		const { pool, layers, changes, add } = await setup();
		const layer = add();
		expect(layer.splats).toBe(10);
		expect(layers.pinned).toBe(CLUSTER);
		expect(changes.count).toBe(1);
		const [{ id }] = layers.drawn();
		expect(id).toBeLessThan(0);
		expect(pool.holds(id)).toBe(true);
		expect(layers.layerOf(layers.numberOf(layer)!)).toBe(layer);
		expect(layers.drawn()).toEqual([{ id, factors: 0xffffffff }]);
		layer.opacity = 2;
		expect(layer.opacity).toBe(1);
		layer.opacity = 0.5;
		expect(layers.drawn()).toEqual([{ id, factors: 0x80808080 }]);
		layer.visible = false;
		expect(layers.drawn()).toEqual([]);
		expect(changes.count).toBe(4);
		pool.destroy();
	});

	it('counts the splats of visible pages in view', async () => {
		const { pool, layers, add } = await setup();
		const layer = add();
		// every plane keeps e >= at, in the frame of origin
		const east = (at: number) => Float32Array.from({ length: 24 }, (_, k) => [1, 0, 0, -at][k % 4]);
		const origin = [500_000, 6_000_000, 0] as const;
		expect(layers.inView(east(5), origin)).toBe(10);
		expect(layers.inView(east(20), origin)).toBe(0);
		layer.visible = false;
		expect(layers.inView(east(5), origin)).toBe(0);
		pool.destroy();
	});

	it('frees its pages on remove, after which the handle does nothing', async () => {
		const { pool, layers, changes, add } = await setup();
		const layer = add();
		const [{ id }] = layers.drawn();
		const number = layers.numberOf(layer)!;
		layer.remove();
		expect(pool.holds(id)).toBe(false);
		expect(layers.pinned).toBe(0);
		expect(layers.layerOf(number)).toBeNull();
		expect(layers.drawn()).toEqual([]);
		expect(changes.count).toBe(2);
		layer.visible = false;
		layer.opacity = 0;
		layer.remove();
		expect([layer.visible, layer.opacity]).toEqual([true, 1]);
		expect(changes.count).toBe(2);
		pool.destroy();
	});

	it('gives null and keeps nothing when the pool cannot hold its pages', async () => {
		const pool = new Pool(await testDevice(), CLUSTER);
		const layers = new Layers(pool, none, () => {});
		const { pack, origin } = await encodeLayer(splats(2 * CLUSTER, [0, 0, 0]));
		expect(layers.add(await layerPages(pack, origin), origin)).toBeNull();
		expect(layers.pinned).toBe(0);
		expect([...pool.ids()].length + pool.queued).toBe(0);
		pool.destroy();
	});
});
