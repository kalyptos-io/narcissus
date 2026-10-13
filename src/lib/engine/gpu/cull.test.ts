import { describe, expect, it } from 'vitest';
import {
	CLUSTER,
	CLUSTER_WORDS,
	COLOUR_WORDS,
	FRAME_UNIFORM_BYTES,
	GEOMETRY_WORDS,
	LOW_PASS,
	PAGE_PARAMS,
	PAGE_WORDS,
	PARAMS,
	WORK
} from '../format/spec.ts';
import { mulberry32 } from '../format/encode.ts';
import { boxVisible, planes } from '../math/frustum.ts';
import { multiply, perspective, view } from '../math/mat4.ts';
import type { DecodedPage, Drawn } from '../types.ts';
import { frameBuffers } from './buffers.ts';
import { Cull } from './cull.ts';
import { Pool } from './pool.ts';
import { readBuffer, testDevice } from './test-device.ts';

const WIDTH = 1920;
const HEIGHT = 1080;
const NEAR = 0.5;
const FAR = 300;

/** writes FrameUniforms for a camera at eye and returns them */
function frame(
	device: GPUDevice,
	buffer: GPUBuffer,
	eye: [number, number, number],
	yaw: number,
	pitch: number,
	clusters: number
): Float32Array {
	const data = new ArrayBuffer(FRAME_UNIFORM_BYTES);
	const f = new Float32Array(data);
	const v = view(new Float32Array(16), eye, yaw, pitch);
	const p = perspective(new Float32Array(16), Math.PI / 3, WIDTH / HEIGHT, NEAR, FAR);
	f.set(v, 0);
	f.set(p, 16);
	multiply(f.subarray(32, 48), p, v);
	planes(f.subarray(48, 72), f.subarray(32, 48));
	f.set(eye, 72);
	f.set([WIDTH, HEIGHT, (p[0] * WIDTH) / 2, (p[5] * HEIGHT) / 2, NEAR, FAR, LOW_PASS], 76);
	new Uint32Array(data)[83] = clusters;
	device.queue.writeBuffer(buffer, 0, data);
	return f;
}

/** a page with random quadrants and cluster boxes scattered around centre, records left zero */
function page(rand: () => number, centre: readonly number[]): DecodedPage {
	const count = 1 + Math.floor(rand() * 4 * CLUSTER);
	const cuts = [rand(), rand(), rand()].map((r) => Math.floor(r * count));
	const [q1, q2, q3] = cuts.sort((a, b) => a - b);
	const params = new Float32Array(PAGE_PARAMS);
	const origin = [rand() * 250, rand() * 250, rand() * 50];
	params.set(origin, PARAMS.origin);
	const clusters = new Float32Array(Math.ceil(count / CLUSTER) * 6);
	for (let c = 0; c < clusters.length; c += 6) {
		for (let k = 0; k < 3; k++) {
			const reach = k === 2 ? 30 : 150;
			const middle = centre[k] + (rand() * 2 - 1) * reach - origin[k];
			const half = 0.5 + rand() * 15;
			clusters[c + k] = middle - half;
			clusters[c + 3 + k] = middle + half;
		}
	}
	return {
		count,
		quadrants: [q1, q2, q3],
		geometry: new Uint32Array(count * GEOMETRY_WORDS),
		colour: new Uint32Array(count * COLOUR_WORDS),
		params,
		clusters
	};
}

async function cull(device: GPUDevice, pool: Pool, eye: [number, number, number]) {
	const buffers = frameBuffers(device, 1024, pool.slots);
	const uniforms = frame(device, buffers.uniforms, eye, 0.5, -0.2, pool.listed);
	device.queue.writeBuffer(buffers.work, 0, new Uint32Array(WORK.list));
	const encoder = device.createCommandEncoder();
	new Cull(device, pool, buffers).encode(encoder);
	device.queue.submit([encoder.finish()]);
	const work = new Uint32Array(await readBuffer(device, buffers.work));
	buffers.destroy();
	return { uniforms, work };
}

/** the cull's rule over the pool's tables as read back */
async function reference(device: GPUDevice, pool: Pool, uniforms: Float32Array) {
	const list = new Uint32Array(await readBuffer(device, pool.list));
	const clusterBytes = await readBuffer(device, pool.clusters);
	const pageBytes = await readBuffer(device, pool.pages);
	const [cu, cf] = [new Uint32Array(clusterBytes), new Float32Array(clusterBytes)];
	const [pu, pf] = [new Uint32Array(pageBytes), new Float32Array(pageBytes)];
	const frustum = uniforms.subarray(48, 72);
	const visible: number[] = [];
	for (const slot of list.subarray(0, pool.listed)) {
		const c = slot * CLUSTER_WORDS;
		const p = cu[c] * PAGE_WORDS;
		const origin = pf.subarray(p, p + 3);
		const min = [0, 1, 2].map((k) => Math.fround(origin[k] + cf[c + 4 + k]));
		const max = [0, 1, 2].map((k) => Math.fround(origin[k] + cf[c + 8 + k]));
		const starts = [0, pu[p + 7], pu[p + 11], pu[p + 15], pu[p + 3]];
		const [first, end] = [cu[c + 2], cu[c + 2] + cu[c + 3]];
		let lit = false;
		for (let k = 0; k < 4; k++) {
			const overlaps = Math.max(starts[k], first) < Math.min(starts[k + 1], end);
			if (overlaps && ((pu[p + 19] >>> (8 * k)) & 255) !== 0) lit = true;
		}
		if (lit && boxVisible(frustum, min, max)) visible.push(slot);
	}
	return visible;
}

describe('Cull', () => {
	it('keeps the clusters inside the frustum with a lit quadrant, as the cpu does', async () => {
		const device = await testDevice();
		const rand = mulberry32(7);
		const eye: [number, number, number] = [125, 125, 20];
		const pool = new Pool(device, 128 * CLUSTER);
		const drawn: Drawn[] = [];
		for (let id = 0; id < 24; id++) {
			expect(pool.add(id, page(rand, eye), [0, 0], () => true)).toBe(true);
			const [a, b, c, d] = [0, 1, 2, 3].map(() => [0, 0, 96, 255][Math.floor(rand() * 4)]);
			drawn.push({ id, factors: (a | (b << 8) | (c << 16) | (d << 24)) >>> 0 });
		}
		pool.upload(Infinity);
		pool.draw(drawn);

		const { uniforms, work } = await cull(device, pool, eye);
		const expected = await reference(device, pool, uniforms);
		const visible = work[WORK.visible];
		const got = [...work.subarray(WORK.list, WORK.list + visible)];
		expect(expected.length).toBeGreaterThan(0);
		expect(expected.length).toBeLessThan(pool.listed);
		expect(got.sort((a, b) => a - b)).toEqual(expected.sort((a, b) => a - b));
		pool.destroy();
	});

	it('lists nothing when nothing is listed', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 4 * CLUSTER);
		pool.draw([]);
		const { work } = await cull(device, pool, [0, 0, 0]);
		expect(work[WORK.visible]).toBe(0);
		pool.destroy();
	});
});
