import { describe, expect, it } from 'vitest';
import {
	CLUSTER,
	COLOUR_WORDS,
	GEOMETRY_WORDS,
	PAGE_PARAMS,
	PARAMS,
	type DecodedPage
} from '../../format/index.ts';
import { Heights } from './heights.ts';
import { Pool } from './pool.ts';
import { testDevice } from './test-device.ts';

const STEP = 0.01;
const SCALES = [0.1, 3];

/** splats at [x, y, z] from origin with an alpha byte and a scale byte on every axis */
function page(origin: number[], splats: [number[], number, number][]): DecodedPage {
	const count = splats.length;
	const geometry = new Uint32Array(count * GEOMETRY_WORDS);
	splats.forEach(([p, alpha, scale], i) => {
		const [x, y, z] = p.map((v) => Math.round(v / STEP));
		geometry.set(
			[x | (y << 16), z | (alpha << 16), (scale << 24) >>> 0, scale | (scale << 8)],
			i * GEOMETRY_WORDS
		);
	});
	const params = new Float32Array(PAGE_PARAMS);
	params.set(origin, PARAMS.origin);
	params.set([STEP, STEP, STEP], PARAMS.step);
	params.set(Array(3).fill(Math.log(SCALES[0])), PARAMS.scaleMin);
	params.set(Array(3).fill(Math.log(SCALES[1])), PARAMS.scaleMax);
	const clusters = new Float32Array(Math.ceil(count / CLUSTER) * 6);
	for (let c = 0; c < clusters.length; c += 6) clusters.set([0, 0, 0, 100, 100, 100], c);
	return {
		count,
		quadrants: [count, count, count],
		geometry,
		colour: new Uint32Array(count * COLOUR_WORDS),
		params,
		clusters
	};
}

async function heights(pool: Pool, x: number, y: number, cells: number) {
	const device = await testDevice();
	const encoder = device.createCommandEncoder();
	const read = new Heights(device, pool).encode(encoder, x, y, cells);
	device.queue.submit([encoder.finish()]);
	return (await read())!;
}

describe('Heights', () => {
	it('keeps the highest solid small splat per cell, inside the window only', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 4 * CLUSTER);
		const near = page(
			[100, 200, -20],
			[
				[[5.5, 5.5, 32], 255, 0],
				[[5.7, 5.2, 33], 255, 0],
				[[6.5, 5.5, 50], 50, 0],
				[[7.5, 5.5, 24], 255, 255],
				[[8.5, 5.5, 15], 255, 0],
				[[30, 30, 60], 255, 0]
			]
		);
		const far = page([1000, 1000, 0], [[[1, 1, 50], 255, 0]]);
		expect(pool.add(0, near, [0, 0], () => true)).toBe(true);
		expect(pool.add(1, far, [0, 0], () => true)).toBe(true);
		pool.upload(Infinity);
		pool.draw([
			{ id: 0, factors: 0xffffffff },
			{ id: 1, factors: 0xffffffff }
		]);

		const cells = 16;
		const tops = await heights(pool, 100, 200, cells);
		const at = (x: number, y: number) => tops[y * cells + x];
		expect(at(5, 5)).toBeCloseTo(13, 4);
		expect(at(8, 5)).toBeCloseTo(-5, 4);
		const filled = [...tops.keys()].filter((i) => !Number.isNaN(tops[i]));
		expect(filled).toEqual([5 * cells + 5, 5 * cells + 8]);
		pool.destroy();
	});

	it('leaves out splats a mask hides', async () => {
		const device = await testDevice();
		const pool = new Pool(device, CLUSTER);
		const solid = page(
			[100, 200, 0],
			[
				[[1.5, 1.5, 5], 255, 0],
				[[2.5, 1.5, 7], 255, 0]
			]
		);
		pool.add(0, solid, [0, 0], () => true);
		pool.upload(Infinity);
		pool.addMask(
			{
				polygon: Float64Array.from([102, 201, 103, 201, 103, 202, 102, 202]),
				z: [-Infinity, Infinity]
			},
			new Set([0])
		);
		pool.draw([{ id: 0, factors: 0xffffffff }]);
		const tops = await heights(pool, 100, 200, 4);
		expect(tops[4 + 1]).toBeCloseTo(5, 4);
		expect(tops[4 + 2]).toBeNaN();
		pool.destroy();
	});

	it('is empty when nothing is drawn', async () => {
		const device = await testDevice();
		const pool = new Pool(device, CLUSTER);
		pool.draw([]);
		const tops = await heights(pool, 0, 0, 4);
		expect(tops.every(Number.isNaN)).toBe(true);
		pool.destroy();
	});
});
