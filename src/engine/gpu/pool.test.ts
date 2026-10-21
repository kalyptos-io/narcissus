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
/** mask words a cluster slot */
const WORDS = CLUSTER / 32;
const SLOT_BYTES = CLUSTER * 28 + 48 + 144 + 4 + 4 * WORDS;

/** a cut mask with the records given drawn */
function mask(...records: number[]): Uint32Array {
	const words = new Uint32Array(Math.ceil((Math.max(...records, 0) + 1) / CLUSTER) * WORDS);
	for (const t of records) words[t >> 5] |= 1 << (t & 31);
	return words;
}

/** every record of a page of count drawn */
const all = (count: number) => mask(...Array.from({ length: count }, (_, t) => t));

function page(count: number, seed = 1): DecodedPage {
	return {
		count,
		geometry: new Uint32Array(count * GEOMETRY_WORDS).map((_, k) => seed * 1e6 + k),
		colour: new Uint32Array(count * COLOUR_WORDS).map((_, k) => seed * 2e6 + k),
		params: new Float32Array(PAGE_PARAMS).map((_, k) => seed + k / 8),
		clusters: new Float32Array(Math.ceil(count / CLUSTER) * 6).map((_, k) => seed + k / 4),
		nodes: {
			counts: new Uint8Array(count),
			centres: new Float32Array(0),
			radii: new Float32Array(0),
			links: new Uint32Array(0)
		}
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
		expect(pool.bytes).toBe(4 * SLOT_BYTES);
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

	it('evicts the least recently kept uploaded pages that keep rejects', async () => {
		const pool = new Pool(await testDevice(), 4 * CLUSTER);
		pool.add(1, page(10), [0, 0], none);
		pool.add(2, page(10), [0, 0], none);
		pool.add(3, page(2 * CLUSTER), [0, 0], none);
		pool.upload(Infinity);
		pool.keep([1]);
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
		pool.keep([2, 4]);
		pool.remove(3);
		pool.remove(4);
		pool.add(5, page(10), [0, 0], none);
		pool.upload(Infinity);
		pool.keep([1]);
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

	it('writes records, clusters and the page entry, and its mask on draw', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 4 * CLUSTER);
		const p = page(300, 3);
		pool.setOrigin([1000, 2000, 10]);
		pool.add(7, p, [1000, 2048], none);
		pool.upload(Infinity);
		pool.draw([{ id: 7, mask: mask(3, 64, CLUSTER + 1, 299) }]);
		expect(pool.listed).toBe(2);

		const list = (await read(device, pool.list)).u;
		const clusters = await read(device, pool.clusters);
		const geometry = (await read(device, pool.geometry)).u;
		const colour = (await read(device, pool.colour)).u;
		const cut = (await read(device, pool.cut)).u;
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
			const bits = c === 0 ? [8, 0, 1, 0, 0, 0, 0, 0] : [2, 0, 0, 0, 0, 0, 0, 0];
			if (c === 1) bits[(299 - CLUSTER) >> 5] |= 1 << ((299 - CLUSTER) & 31);
			expect(slice(cut, slot * WORDS, WORDS)).toEqual(bits.slice(0, WORDS));
		}

		const pages = await read(device, pool.pages);
		const w = table * PAGE_WORDS;
		const o = PARAMS.origin;
		expect(slice(pages.f, w, 3)).toEqual([
			Math.fround(p.params[o] + 1000 - 1000),
			Math.fround(p.params[o + 1] + 2048 - 2000),
			Math.fround(p.params[o + 2] - 10)
		]);
		expect(pages.u[w + 3]).toBe(300);
		expect(slice(pages.f, w + 4, 3)).toEqual(slice(p.params, PARAMS.step, 3));
		expect(slice(pages.f, w + 8, 3)).toEqual(slice(p.params, PARAMS.scaleMin, 3));
		expect(slice(pages.f, w + 12, 3)).toEqual(slice(p.params, PARAMS.scaleMax, 3));
		expect(slice(pages.f, w + 16, 3)).toEqual(slice(p.params, PARAMS.dcMin, 3));
		expect(slice(pages.f, w + 20, 3)).toEqual(slice(p.params, PARAMS.dcMax, 3));
		expect(slice(pages.f, w + 24, 9)).toEqual(slice(p.params, PARAMS.shScale, 9));
		pool.destroy();
	});

	it('grows with its pages in place and room for more', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 2 * CLUSTER);
		const first = page(300, 4);
		const second = page(CLUSTER, 6);
		pool.add(1, first, [0, 0], none);
		pool.upload(Infinity);
		pool.draw([{ id: 1, mask: all(300) }]);
		expect(pool.add(2, second, [0, 0], (id) => id === 1)).toBe(false);

		// the writes above are still queued, so the copy must come after them
		pool.grow(4 * CLUSTER);
		expect(pool.bytes).toBe(4 * SLOT_BYTES);
		expect(pool.has(1)).toBe(true);
		expect(pool.add(2, second, [0, 0], none)).toBe(true);
		pool.upload(Infinity);
		pool.draw([{ id: 2, mask: all(CLUSTER) }]);
		expect(pool.listed).toBe(3);

		const list = (await read(device, pool.list)).u;
		const clusters = (await read(device, pool.clusters)).u;
		const geometry = (await read(device, pool.geometry)).u;
		const pages = (await read(device, pool.pages)).u;
		const cut = (await read(device, pool.cut)).u;
		expect(slice(list, 0, 3)).toEqual([0, 1, 2]);
		expect(slice(cut, 0, 3 * WORDS)).toEqual([...all(300), ...all(CLUSTER)]);
		expect(slice(geometry, 0, 300 * GEOMETRY_WORDS)).toEqual([...first.geometry]);
		const added = slice(geometry, 2 * CLUSTER * GEOMETRY_WORDS, CLUSTER * GEOMETRY_WORDS);
		expect(added).toEqual([...second.geometry]);
		expect(pages[clusters[0] * PAGE_WORDS + 3]).toBe(300);
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
			{ id: 2, mask: all(10) },
			{ id: 1, mask: all(300) }
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

		pool.draw([{ id: 1, mask: new Uint32Array(0) }]);
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
			{ id: 5, mask: all(added.count) },
			{ id: 2, mask: all(neighbour.count) }
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
		pool.draw([5, 6, 7, 8].map((id) => ({ id, mask: all(CLUSTER * 3) })));
		expect(slice((await read(device, pool.list)).u, 0, pool.listed)).toEqual([
			4, 5, 6, 0, 1, 7, 2, 3
		]);
		pool.destroy();
	});

	it('lists the clusters with a drawn record as their masks change', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 4 * CLUSTER);
		pool.add(1, page(1000), [0, 0], none);
		pool.upload(Infinity);
		const draw = async (bits: Uint32Array) => {
			pool.draw([{ id: 1, mask: bits }]);
			return slice((await read(device, pool.list)).u, 0, pool.listed);
		};
		expect(await draw(mask(0))).toEqual([0]);
		expect(await draw(mask(CLUSTER - 1, CLUSTER))).toEqual([0, 1]);
		expect(await draw(mask(999))).toEqual([3]);
		expect(await draw(mask(2 * CLUSTER + 5, 300))).toEqual([1, 2]);
		expect(await draw(new Uint32Array(0))).toEqual([]);
		expect(await draw(all(1000))).toEqual([0, 1, 2, 3]);
		pool.destroy();
	});

	it('keeps the masks a draw leaves out, and forgets those of removed pages', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 8 * CLUSTER);
		pool.add(1, page(2 * CLUSTER), [0, 0], none);
		pool.add(2, page(2 * CLUSTER), [0, 0], none);
		pool.add(3, page(CLUSTER), [0, 0], none);
		pool.upload(Infinity);
		const draw = async (changes: [number, Uint32Array][]) => {
			pool.draw(changes.map(([id, bits]) => ({ id, mask: bits })));
			return slice((await read(device, pool.list)).u, 0, pool.listed);
		};
		const empty = new Uint32Array(0);
		expect(
			await draw([
				[1, all(2 * CLUSTER)],
				[2, all(2 * CLUSTER)],
				[3, all(CLUSTER)]
			])
		).toEqual([0, 1, 2, 3, 4]);
		expect(pool.drawn).toBe(3);
		expect(await draw([])).toEqual([0, 1, 2, 3, 4]);
		expect(await draw([[2, mask(CLUSTER)]])).toEqual([0, 1, 3, 4]);
		expect(await draw([[1, empty]])).toEqual([3, 4]);
		expect(await draw([[1, mask(0)]])).toEqual([3, 4, 0]);
		expect(pool.gone()).toEqual([]);
		pool.remove(2);
		expect(pool.gone()).toEqual([2]);
		expect(pool.gone()).toEqual([]);
		expect(await draw([])).toEqual([4, 0]);
		pool.add(2, page(CLUSTER), [0, 0], none);
		pool.upload(Infinity);
		expect(await draw([])).toEqual([4, 0]);
		expect(pool.drawn).toBe(2);
		const cut = (await read(device, pool.cut)).u;
		expect(slice(cut, 2 * WORDS, WORDS)).toEqual(new Array(WORDS).fill(0));
		pool.destroy();
	});
});
