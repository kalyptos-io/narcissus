import { describe, expect, it } from 'vitest';
import { WORK } from '../format/spec.ts';
import { frameBuffers } from './buffers.ts';
import { Sort } from './sort.ts';
import { readBuffer, testDevice } from './test-device.ts';

const COUNTS = [0, 1, 255, 256, 257, 100_000, 1_000_000];

// 24-bit keys where every third repeats an earlier one, so ties span all digits
function testKeys(count: number): Uint32Array {
	let seed = count + 1;
	const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
	const keys = new Uint32Array(count);
	for (let i = 0; i < count; i++) keys[i] = i % 3 === 2 ? keys[next() % i] : next() >>> 8;
	return keys;
}

/** sorts keys with values 1, 2, ... after writing projected into WORK.projected */
async function gpuSort(keys: Uint32Array, projected: number, capacity: number) {
	const device = await testDevice();
	const buffers = frameBuffers(device, capacity, 1);
	const sort = new Sort(device, buffers);
	const stored = keys.subarray(0, capacity);
	device.queue.writeBuffer(buffers.sort, 0, stored);
	device.queue.writeBuffer(
		buffers.sort,
		capacity * 4,
		stored.map((_, i) => i + 1)
	);
	device.queue.writeBuffer(buffers.work, WORK.projected * 4, new Uint32Array([projected]));
	const encoder = device.createCommandEncoder();
	sort.encode(encoder);
	device.queue.submit([encoder.finish()]);
	const read = async (offset: number) =>
		new Uint32Array(await readBuffer(device, buffers.sort, offset, capacity * 4));
	const result = {
		keys: await read(sort.keys),
		values: await read(sort.values),
		draw: [...new Uint32Array(await readBuffer(device, buffers.work, WORK.drawArgs * 4, 16))]
	};
	sort.destroy();
	buffers.destroy();
	return result;
}

/** Array.prototype.sort is stable, so ties keep their input order */
function cpuSort(keys: Uint32Array) {
	const order = Array.from(keys, (_, i) => i).sort((a, b) => keys[a] - keys[b]);
	return { keys: order.map((i) => keys[i]), values: order.map((i) => i + 1) };
}

/** first index where got differs from want, or -1 */
function mismatch(got: Uint32Array, want: number[]): number {
	return want.findIndex((v, i) => got[i] !== v);
}

describe('Sort', () => {
	for (const count of COUNTS) {
		it(`sorts ${count} keys and keeps ties in order`, { timeout: 30_000 }, async () => {
			const keys = testKeys(count);
			const got = await gpuSort(keys, count, count + 3);
			const want = cpuSort(keys);
			expect(mismatch(got.keys, want.keys)).toBe(-1);
			expect(mismatch(got.values, want.values)).toBe(-1);
			expect(got.draw).toEqual([4, count, 0, 0]);
		});
	}

	it('sorts only the keys that fit when more were projected', async () => {
		const keys = testKeys(300);
		const got = await gpuSort(keys, 300, 200);
		const want = cpuSort(keys.subarray(0, 200));
		expect(mismatch(got.keys, want.keys)).toBe(-1);
		expect(mismatch(got.values, want.values)).toBe(-1);
		expect(got.draw).toEqual([4, 200, 0, 0]);
	});
});
