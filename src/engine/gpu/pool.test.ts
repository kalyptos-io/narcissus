import { describe, expect, it } from 'vitest';
import {
	CLUSTER,
	COLOUR_WORDS,
	GEOMETRY_WORDS,
	PAGE_PARAMS,
	PARAMS,
	type DecodedPage
} from '../../format/index.ts';
import { CLUSTER_WORDS, PAGE_WORDS } from './layout.ts';
import { Pool } from './pool.ts';
import { readBuffer, testDevice } from './test-device.ts';

const none = () => false;

function page(count: number, seed = 1): DecodedPage {
	return {
		count,
		quadrants: [count >> 2, count >> 1, (3 * count) >> 2],
		geometry: new Uint32Array(count * GEOMETRY_WORDS).map((_, k) => seed * 1e6 + k),
		colour: new Uint32Array(count * COLOUR_WORDS).map((_, k) => seed * 2e6 + k),
		params: new Float32Array(PAGE_PARAMS).map((_, k) => seed + k / 8),
		clusters: new Float32Array(Math.ceil(count / CLUSTER) * 6).map((_, k) => seed + k / 4)
	};
}

async function read(device: GPUDevice, buffer: GPUBuffer) {
	const bytes = await readBuffer(device, buffer);
	return { u: new Uint32Array(bytes), f: new Float32Array(bytes) };
}

function slice(a: Uint32Array | Float32Array, at: number, n: number): number[] {
	return [...a.subarray(at, at + n)];
}

describe('Pool', () => {
	it('sizes its buffers from the capacity', async () => {
		const pool = new Pool(await testDevice(), 4 * CLUSTER);
		expect(pool.slots).toBe(4);
		expect(pool.bytes).toBe(4 * CLUSTER * 28 + 4 * (48 + 144 + 4));
		pool.destroy();
	});

	it('takes a slot per started cluster and never evicts queued pages', async () => {
		const pool = new Pool(await testDevice(), 4 * CLUSTER);
		expect(pool.add(1, page(300), [0, 0], none)).toBe(true);
		expect(pool.add(2, page(CLUSTER), [0, 0], none)).toBe(true);
		expect(pool.add(3, page(2 * CLUSTER), [0, 0], none)).toBe(false);
		expect(pool.queued).toBe(2);
		expect(pool.holds(1)).toBe(true);
		expect(pool.has(1)).toBe(false);
		expect(pool.holds(3)).toBe(false);
		pool.destroy();
	});

	it('uploads queued pages in order until the byte budget is spent', async () => {
		const pool = new Pool(await testDevice(), 4 * CLUSTER);
		pool.add(1, page(300), [0, 0], none);
		pool.add(2, page(10), [0, 0], none);
		expect(pool.upload(1)).toBe(300 * 28 + 2 * 48 + 144);
		expect(pool.has(1)).toBe(true);
		expect(pool.has(2)).toBe(false);
		expect(pool.holds(2)).toBe(true);
		expect(pool.queued).toBe(1);
		expect(pool.upload(0)).toBe(0);
		pool.upload(Infinity);
		expect([...pool.ids()]).toEqual([1, 2]);
		expect(pool.queued).toBe(0);
		pool.destroy();
	});

	it('evicts the least recently drawn uploaded pages that keep rejects', async () => {
		const pool = new Pool(await testDevice(), 4 * CLUSTER);
		pool.add(1, page(10), [0, 0], none);
		pool.add(2, page(10), [0, 0], none);
		pool.add(3, page(2 * CLUSTER), [0, 0], none);
		pool.upload(Infinity);
		pool.draw([{ id: 1, factors: 1 }]);
		// recency is now 2, 3, 1 and keep holds 2, so 3 goes
		expect(pool.add(4, page(10), [0, 0], (id) => id === 2)).toBe(true);
		expect(pool.holds(3)).toBe(false);
		expect(pool.holds(2)).toBe(true);
		expect(pool.holds(1)).toBe(true);
		expect(pool.add(5, page(2 * CLUSTER), [0, 0], none)).toBe(true);
		expect(pool.holds(2)).toBe(false);
		expect(pool.holds(1)).toBe(true);
		// page 1 is all that is uploaded and too small to make room, so it stays
		expect(pool.add(6, page(4 * CLUSTER), [0, 0], none)).toBe(false);
		expect(pool.holds(1)).toBe(true);
		pool.destroy();
	});

	it('frees the slots of a removed page', async () => {
		const pool = new Pool(await testDevice(), 2 * CLUSTER);
		pool.add(1, page(2 * CLUSTER), [0, 0], none);
		pool.remove(1);
		expect(pool.holds(1)).toBe(false);
		expect(pool.queued).toBe(0);
		expect(pool.add(2, page(2 * CLUSTER), [0, 0], () => true)).toBe(true);
		pool.destroy();
	});

	it('preserves recency after removing middle, newest, and oldest pages', async () => {
		const pool = new Pool(await testDevice(), 4 * CLUSTER);
		for (const id of [1, 2, 3, 4]) pool.add(id, page(10), [0, 0], none);
		pool.upload(Infinity);
		pool.draw([
			{ id: 2, factors: 1 },
			{ id: 4, factors: 1 }
		]);
		pool.remove(3);
		pool.remove(4);
		pool.add(5, page(10), [0, 0], none);
		pool.upload(Infinity);
		pool.draw([{ id: 1, factors: 1 }]);
		pool.remove(2);
		for (const id of [6, 7, 8]) {
			pool.add(id, page(10), [0, 0], none);
			pool.upload(Infinity);
		}
		expect([...pool.ids()]).toEqual([1, 6, 7, 8]);
		expect(pool.holds(5)).toBe(false);
		pool.clear();
		pool.add(9, page(10), [0, 0], none);
		pool.upload(Infinity);
		expect([...pool.ids()]).toEqual([9]);
		pool.destroy();
	});

	it('holds nothing once cleared', async () => {
		const pool = new Pool(await testDevice(), 2 * CLUSTER);
		pool.add(1, page(CLUSTER), [0, 0], none);
		pool.add(2, page(CLUSTER), [0, 0], none);
		pool.upload(Infinity);
		pool.clear();
		expect([...pool.ids()]).toEqual([]);
		expect(pool.add(3, page(2 * CLUSTER), [0, 0], () => true)).toBe(true);
		pool.destroy();
	});

	it('writes records, clusters and the page entry, and factors on draw', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 4 * CLUSTER);
		const p = page(300, 3);
		pool.setOrigin([1000, 2000, 10]);
		pool.add(7, p, [1000, 2048], none);
		pool.upload(Infinity);
		pool.draw([{ id: 7, factors: 0x01020304 }]);
		expect(pool.listed).toBe(2);

		const list = (await read(device, pool.list)).u;
		const clusters = await read(device, pool.clusters);
		const geometry = (await read(device, pool.geometry)).u;
		const colour = (await read(device, pool.colour)).u;
		const table = clusters.u[list[0] * CLUSTER_WORDS];
		for (let c = 0; c < 2; c++) {
			const slot = list[c];
			const w = slot * CLUSTER_WORDS;
			const count = c === 0 ? CLUSTER : 300 - CLUSTER;
			const entry = [table, slot * CLUSTER, c * CLUSTER, count];
			expect(slice(clusters.u, w, 4)).toEqual(entry);
			expect(slice(clusters.f, w + 4, 3)).toEqual(slice(p.clusters, c * 6, 3));
			expect(slice(clusters.f, w + 8, 3)).toEqual(slice(p.clusters, c * 6 + 3, 3));
			const g = count * GEOMETRY_WORDS;
			const records = slice(geometry, slot * CLUSTER * GEOMETRY_WORDS, g);
			expect(records).toEqual(slice(p.geometry, c * CLUSTER * GEOMETRY_WORDS, g));
			const k = count * COLOUR_WORDS;
			const colours = slice(colour, slot * CLUSTER * COLOUR_WORDS, k);
			expect(colours).toEqual(slice(p.colour, c * CLUSTER * COLOUR_WORDS, k));
		}

		const pages = await read(device, pool.pages);
		const w = table * PAGE_WORDS;
		const o = PARAMS.origin;
		expect(slice(pages.f, w, 3)).toEqual([
			Math.fround(p.params[o] + 1000 - 1000),
			Math.fround(p.params[o + 1] + 2048 - 2000),
			Math.fround(p.params[o + 2] - 10)
		]);
		const counts = [pages.u[w + 3], pages.u[w + 7], pages.u[w + 11], pages.u[w + 15]];
		expect(counts).toEqual([300, ...p.quadrants]);
		expect(slice(pages.f, w + 4, 3)).toEqual(slice(p.params, PARAMS.step, 3));
		expect(slice(pages.f, w + 8, 3)).toEqual(slice(p.params, PARAMS.scaleMin, 3));
		expect(slice(pages.f, w + 12, 3)).toEqual(slice(p.params, PARAMS.scaleMax, 3));
		expect(slice(pages.f, w + 16, 3)).toEqual(slice(p.params, PARAMS.dcMin, 3));
		expect(slice(pages.f, w + 20, 3)).toEqual(slice(p.params, PARAMS.dcMax, 3));
		expect(slice(pages.f, w + 24, 9)).toEqual(slice(p.params, PARAMS.shScale, 9));
		expect(pages.u[w + 19]).toBe(0x01020304);
		pool.destroy();
	});

	it('grows with its pages in place and room for more', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 2 * CLUSTER);
		const first = page(300, 4);
		const second = page(CLUSTER, 6);
		pool.add(1, first, [0, 0], none);
		pool.upload(Infinity);
		pool.draw([{ id: 1, factors: 0xffffffff }]);
		expect(pool.add(2, second, [0, 0], (id) => id === 1)).toBe(false);

		// the writes above are still queued, so the copy must come after them
		pool.grow(4 * CLUSTER);
		expect(pool.bytes).toBe(4 * CLUSTER * 28 + 4 * (48 + 144 + 4));
		expect(pool.has(1)).toBe(true);
		expect(pool.add(2, second, [0, 0], none)).toBe(true);
		pool.upload(Infinity);
		pool.draw([
			{ id: 1, factors: 0x01010101 },
			{ id: 2, factors: 0xffffffff }
		]);
		expect(pool.listed).toBe(3);

		const list = (await read(device, pool.list)).u;
		const clusters = (await read(device, pool.clusters)).u;
		const geometry = (await read(device, pool.geometry)).u;
		const pages = (await read(device, pool.pages)).u;
		expect(slice(list, 0, 3)).toEqual([0, 1, 2]);
		expect(slice(geometry, 0, 300 * GEOMETRY_WORDS)).toEqual([...first.geometry]);
		const added = slice(geometry, 2 * CLUSTER * GEOMETRY_WORDS, CLUSTER * GEOMETRY_WORDS);
		expect(added).toEqual([...second.geometry]);
		expect(pages[clusters[0] * PAGE_WORDS + 3]).toBe(300);
		expect(pages[clusters[0] * PAGE_WORDS + 19]).toBe(0x01010101);
		pool.destroy();
	});

	it('lists only drawn uploaded pages and rewrites origins on setOrigin', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 4 * CLUSTER);
		const p = page(300, 5);
		pool.add(1, p, [250, 500], none);
		pool.add(2, page(10), [0, 0], none);
		pool.upload(1);
		pool.draw([
			{ id: 2, factors: 9 },
			{ id: 1, factors: 0xffffffff }
		]);
		expect(pool.listed).toBe(2);
		const list = (await read(device, pool.list)).u;
		const clusters = (await read(device, pool.clusters)).u;
		const [a, b] = [list[0] * CLUSTER_WORDS, list[1] * CLUSTER_WORDS];
		expect([clusters[a], clusters[a + 2], clusters[b + 2]]).toEqual([clusters[b], 0, CLUSTER]);

		pool.setOrigin([5, -3, 1]);
		const pages = await read(device, pool.pages);
		const w = clusters[a] * PAGE_WORDS;
		const o = PARAMS.origin;
		expect(slice(pages.f, w, 3)).toEqual([
			Math.fround(p.params[o] + 250 - 5),
			Math.fround(p.params[o + 1] + 500 + 3),
			Math.fround(p.params[o + 2] - 1)
		]);
		expect(pages.u[w + 19]).toBe(0xffffffff);

		pool.draw([]);
		expect(pool.listed).toBe(0);
		pool.destroy();
	});

	it('uploads a page across fragmented slots without changing its neighbours', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 8 * CLUSTER);
		const neighbour = page(2 * CLUSTER, 2);
		for (let id = 1; id <= 4; id++) {
			pool.add(id, id === 2 ? neighbour : page(2 * CLUSTER, id), [0, 0], none);
		}
		pool.upload(Infinity);
		pool.remove(1);
		pool.remove(3);
		const added = page(3 * CLUSTER - 7, 5);
		expect(pool.add(5, added, [0, 0], () => true)).toBe(true);
		pool.upload(Infinity);
		pool.draw([
			{ id: 5, factors: 0xffffffff },
			{ id: 2, factors: 0xffffffff }
		]);
		const list = (await read(device, pool.list)).u;
		const geometry = (await read(device, pool.geometry)).u;
		const colour = (await read(device, pool.colour)).u;
		let at = 0;
		for (const source of [added, neighbour]) {
			for (let first = 0; first < source.count; first += CLUSTER) {
				const slot = list[at++];
				const count = Math.min(CLUSTER, source.count - first);
				expect(slice(geometry, slot * CLUSTER * GEOMETRY_WORDS, count * GEOMETRY_WORDS)).toEqual(
					slice(source.geometry, first * GEOMETRY_WORDS, count * GEOMETRY_WORDS)
				);
				expect(slice(colour, slot * CLUSTER * COLOUR_WORDS, count * COLOUR_WORDS)).toEqual(
					slice(source.colour, first * COLOUR_WORDS, count * COLOUR_WORDS)
				);
			}
		}
		pool.destroy();
	});

	it('prefers a later contiguous run and then reuses the earlier gap', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 8 * CLUSTER);
		for (const id of [1, 2, 3, 4]) pool.add(id, page(2 * CLUSTER), [0, 0], none);
		for (const id of [1, 3, 4]) pool.remove(id);
		pool.add(5, page(3 * CLUSTER), [0, 0], none);
		pool.add(6, page(2 * CLUSTER), [0, 0], none);
		pool.add(7, page(CLUSTER), [0, 0], none);
		pool.remove(2);
		pool.add(8, page(2 * CLUSTER), [0, 0], none);
		pool.upload(Infinity);
		pool.draw([5, 6, 7, 8].map((id) => ({ id, factors: 0xffffffff })));
		expect(slice((await read(device, pool.list)).u, 0, pool.listed)).toEqual([
			4, 5, 6, 0, 1, 7, 2, 3
		]);
		pool.destroy();
	});

	it('lists clusters that overlap active quadrants when their factors change', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 4 * CLUSTER);
		const source = page(1000);
		source.quadrants = [100, 300, 900];
		pool.add(1, source, [0, 0], none);
		pool.upload(Infinity);
		const draw = async (factors: number) => {
			pool.draw([{ id: 1, factors }]);
			return slice((await read(device, pool.list)).u, 0, pool.listed);
		};
		expect(await draw(0xff)).toEqual([0]);
		expect(await draw(0xff00)).toEqual([0, 1]);
		expect(await draw(0x8000)).toEqual([0, 1]);
		expect(await draw(0xff0000)).toEqual([1, 2, 3]);
		expect(await draw(0xff000000)).toEqual([3]);
		expect(await draw(0xffff)).toEqual([0, 1]);
		expect(await draw(0)).toEqual([]);
		expect(await draw(0xffffffff)).toEqual([0, 1, 2, 3]);
		pool.remove(1);
		source.quadrants = [0, 0, 500];
		pool.add(1, source, [0, 0], none);
		pool.upload(Infinity);
		expect(await draw(0xff)).toEqual([]);
		expect(await draw(0xff00)).toEqual([]);
		expect(await draw(0xff0000)).toEqual([0, 1]);
		expect(await draw(0xff000000)).toEqual([1, 2, 3]);
		pool.remove(1);
		pool.add(1, page(0), [0, 0], none);
		pool.upload(Infinity);
		expect(await draw(0xffffffff)).toEqual([]);
		pool.destroy();
	});

	it('updates repeated draws after factor changes, reordering and slot reuse', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 8 * CLUSTER);
		pool.add(1, page(2 * CLUSTER), [0, 0], none);
		pool.add(2, page(2 * CLUSTER), [0, 0], none);
		pool.add(3, page(CLUSTER), [0, 0], none);
		pool.upload(Infinity);
		const draw = async (ids: number[], factors = 0xffffffff) => {
			pool.draw(ids.map((id) => ({ id, factors })));
			return slice((await read(device, pool.list)).u, 0, pool.listed);
		};
		expect(await draw([1, 2, 3])).toEqual([0, 1, 2, 3, 4]);
		expect(await draw([1, 2, 3], 0x01020304)).toEqual([0, 1, 2, 3, 4]);
		const clusters = (await read(device, pool.clusters)).u;
		const pages = (await read(device, pool.pages)).u;
		expect(pages[clusters[0] * PAGE_WORDS + 19]).toBe(0x01020304);
		expect(await draw([1, 2])).toEqual([0, 1, 2, 3]);
		expect(await draw([3, 2])).toEqual([4, 2, 3]);
		expect(await draw([2, 3])).toEqual([2, 3, 4]);
		pool.remove(2);
		pool.add(2, page(CLUSTER), [0, 0], none);
		pool.upload(Infinity);
		expect(await draw([2, 3])).toEqual([2, 4]);
		expect(await draw([])).toEqual([]);
		expect(await draw([1])).toEqual([0, 1]);
		pool.destroy();
	});
});
