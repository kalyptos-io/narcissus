import { describe, expect, it, vi } from 'vitest';
import { CLUSTER } from '../format/index.ts';
import { deflate, encodeLayer, encodePack, encodePage, type Splats } from '../format/encode.ts';
import { Pool } from './gpu/pool.ts';
import { testDevice } from './gpu/test-device.ts';
import { boxOf, layerPages, Layers, readLayer, type Layer } from './layer.ts';

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

describe('readLayer', () => {
	const unread = () => Promise.reject(new Error('read'));

	it('rejects with the reason of an abort, during the read or after it', async () => {
		const { pack, origin } = await encodeLayer(splats(10, [0, 0, 0]));
		const controller = new AbortController();
		const reason = new Error('gone');
		const fetch = (_url: string, _range: unknown, signal?: AbortSignal) => {
			controller.abort(reason);
			return signal!.aborted ? Promise.reject(signal!.reason) : Promise.resolve(pack);
		};
		const { signal } = controller;
		await expect(readLayer({ url: 'layer.pack', origin, signal }, fetch)).rejects.toBe(reason);
		const late = new AbortController();
		late.abort(reason);
		const read = readLayer({ bytes: pack, origin, signal: late.signal }, unread);
		await expect(read).rejects.toBe(reason);
	});

	it('throws a RangeError that names the field out of range, before it reads', async () => {
		const bytes = new Uint8Array(0);
		const origin = [0, 0] as const;
		const cases: [object, string][] = [
			[{ origin: [0, NaN] }, 'origin'],
			[{ origin: [0] }, 'origin'],
			[{ origin, position: [0, 0] }, 'position'],
			[{ origin, position: [0, 0, Infinity] }, 'position'],
			[{ origin, heading: NaN }, 'heading'],
			[{ origin, opacity: 1.5 }, 'opacity'],
			[{ origin, opacity: NaN }, 'opacity']
		];
		for (const [options, field] of cases) {
			const read = readLayer({ bytes, ...options } as Parameters<typeof readLayer>[0], unread);
			await expect(read).rejects.toThrow(new RangeError(`A layer's ${field}`).message);
			await expect(read).rejects.toBeInstanceOf(RangeError);
		}
	});
});

describe('Layers', () => {
	const none = () => false;

	/** a pool of four clusters, layers over it and the count of their changes */
	async function setup() {
		const pool = new Pool(await testDevice(), 4 * CLUSTER);
		const changes = { count: 0 };
		const layers = new Layers(
			pool,
			none,
			() => changes.count++,
			() => true
		);
		const { pack, origin } = await encodeLayer(splats(10, [500_000.5, 6_000_000.25, 12]));
		const pages = await layerPages(pack, origin);
		const add = (options: Omit<Parameters<Layers['add']>[1], 'bytes' | 'origin'> = {}) =>
			layers.add(pages, { bytes: pack, origin, ...options })!;
		return { pool, layers, changes, add };
	}

	/** box's sides to 2 decimals: e, n, h */
	const sides = ({ box }: Layer) => [...box.e, ...box.n, ...box.h].map((v) => +v.toFixed(2));

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
		expect(() => (layer.opacity = 2)).toThrow(RangeError);
		expect(layer.opacity).toBe(1);
		layer.opacity = 0.5;
		expect(layers.drawn()).toEqual([{ id, factors: 0x80808080 }]);
		layer.visible = false;
		expect(layers.drawn()).toEqual([]);
		expect(changes.count).toBe(3);
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

	it('shows where it was encoded until moved, its anchor the centre of its box at its lowest splat', async () => {
		const { pool, add } = await setup();
		const layer = add();
		// as layerPages's box, but from the decoded clusters' extents
		expect(sides(layer)).toEqual([500_000.2, 500_009.8, 5_999_999.95, 6_000_000.55, 11.7, 12.3]);
		expect(layer.position.map((v) => +v.toFixed(2))).toEqual([500_005, 6_000_000.25, 12]);
		expect(layer.heading).toBe(0);
		layer.position = [10, 20, 30];
		// the splats' centres rest on position, their 3 sigma reaches below it
		expect(sides(layer)).toEqual([5.2, 14.8, 19.7, 20.3, 29.7, 30.3]);
		pool.destroy();
	});

	it('rests its anchor on its lowest splat centre, whatever the height of the others', async () => {
		const { pool, layers } = await setup();
		const tall = splats(3, [100, 200, 0]);
		tall.position.set([5, 2.5, 9].flatMap((h, k) => [100 + k, 200, h]));
		const { pack, origin } = await encodeLayer(tall);
		const layer = layers.add(await layerPages(pack, origin), { bytes: pack, origin })!;
		expect(layer.position.map((v) => +v.toFixed(3))).toEqual([101, 200, 2.5]);
		pool.destroy();
	});

	it('turns clockwise about its position by heading: north turns east at 90', async () => {
		const { pool, add } = await setup();
		const place = vi.spyOn(pool, 'place');
		const layer = add({ position: [0, 0, 0] });
		const [e, n, h] = place.mock.lastCall![1];
		// the page origin lies south-west of the anchor
		expect(e < 0 && n < 0).toBe(true);
		layer.heading = 90;
		// splats run 4.8 m either side of the anchor along e, 0.3 m along n
		expect(sides(layer)).toEqual([-0.3, 0.3, -4.8, 4.8, -0.3, 0.3]);
		expect(place.mock.lastCall![1]).toEqual([expect.closeTo(n, 9), expect.closeTo(-e, 9), h]);
		layer.heading = 180;
		expect(sides(layer)).toEqual([-4.8, 4.8, -0.3, 0.3, -0.3, 0.3]);
		expect(place.mock.lastCall![1]).toEqual([expect.closeTo(-e, 9), expect.closeTo(-n, 9), h]);
		pool.destroy();
	});

	it('places its pages in the pool, once a frame however often it moves', async () => {
		const { pool, layers, changes, add } = await setup();
		const layer = add({ position: [0, 0, 0] });
		const place = vi.spyOn(pool, 'place');
		layer.position = [1, 0, 0];
		layer.heading = 45;
		layer.position = [500_000, 6_000_000, 0];
		expect(changes.count).toBe(4);
		const east = (at: number) => Float32Array.from({ length: 24 }, (_, k) => [1, 0, 0, -at][k % 4]);
		expect(layers.inView(east(-10), [500_000, 6_000_000, 0])).toBe(10);
		layers.drawn();
		expect(place).toHaveBeenCalledOnce();
		const [id, , turn] = place.mock.calls[0];
		expect(id).toBe(layers.drawn()[0].id);
		expect(turn).toEqual([Math.SQRT1_2, Math.SQRT1_2].map((v) => expect.closeTo(v, 12)));
		pool.destroy();
	});

	it('frees its pages on remove, after which the handle does nothing', async () => {
		const { pool, layers, changes, add } = await setup();
		const layer = add({ pickable: false });
		expect(layer.pickable).toBe(false);
		const [{ id }] = layers.drawn();
		const number = layers.numberOf(layer)!;
		const [box, position] = [sides(layer), layer.position];
		layer.remove();
		expect(pool.holds(id)).toBe(false);
		expect(layers.pinned).toBe(0);
		expect(layers.layerOf(number)).toBeNull();
		expect(layers.numberOf(layer)).toBeUndefined();
		expect(layers.drawn()).toEqual([]);
		expect(changes.count).toBe(2);
		layer.visible = false;
		layer.opacity = 0;
		layer.position = [0, 0, 0];
		layer.heading = 90;
		layer.pickable = true;
		layer.remove();
		const { visible, opacity, heading, pickable } = layer;
		expect([visible, opacity, layer.position, heading, pickable]).toEqual([
			true,
			1,
			position,
			0,
			false
		]);
		expect(sides(layer)).toEqual(box);
		expect(changes.count).toBe(2);
		pool.destroy();
	});

	it('gives null and keeps nothing when the pool cannot hold its pages', async () => {
		const pool = new Pool(await testDevice(), CLUSTER);
		const layers = new Layers(
			pool,
			none,
			() => {},
			() => true
		);
		const { pack, origin } = await encodeLayer(splats(2 * CLUSTER, [0, 0, 0]));
		expect(layers.add(await layerPages(pack, origin), { bytes: pack, origin })).toBeNull();
		expect(layers.pinned).toBe(0);
		expect([...pool.ids()].length + pool.queued).toBe(0);
		pool.destroy();
	});
});
