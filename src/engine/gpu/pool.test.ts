import { describe, expect, it } from 'vitest';
import {
	CLUSTER,
	CLUSTER_WORDS,
	COLOUR_WORDS,
	GEOMETRY_WORDS,
	PAGE_PARAMS,
	PAGE_WORDS,
	PARAMS
} from '../../format/spec.ts';
import type { DecodedPage } from '../../format/types.ts';
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
		expect(pool.used).toBe(300 + CLUSTER);
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
		expect(pool.used).toBe(10 + 10 + 2 * CLUSTER);
		pool.destroy();
	});

	it('frees the slots of a removed page', async () => {
		const pool = new Pool(await testDevice(), 2 * CLUSTER);
		pool.add(1, page(2 * CLUSTER), [0, 0], none);
		pool.remove(1);
		expect(pool.holds(1)).toBe(false);
		expect(pool.used).toBe(0);
		expect(pool.queued).toBe(0);
		expect(pool.add(2, page(2 * CLUSTER), [0, 0], () => true)).toBe(true);
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

	it('lists only drawn uploaded pages and rewrites origins on setOrigin', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 4 * CLUSTER);
		const p = page(300, 5);
		pool.add(1, p, [250, 500], none);
		pool.add(2, page(10), [0, 0], none);
		pool.upload(1);
		pool.draw([
			{ id: 2, factors: 9 },
			{ id: 1, factors: 0xff }
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
		expect(pages.u[w + 19]).toBe(0xff);

		pool.draw([]);
		expect(pool.listed).toBe(0);
		pool.destroy();
	});
});
