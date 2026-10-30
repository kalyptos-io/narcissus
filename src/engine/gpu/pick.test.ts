import { describe, expect, it } from 'vitest';
import { decodePage } from '../../format/index.ts';
import { encodePage } from '../../format/encode.ts';
import { planes } from '../math/frustum.ts';
import { multiply, perspective, view } from '../math/mat4.ts';
import type { Frame } from '../plugin.ts';
import { frameBuffers } from './buffers.ts';
import { FRAME_UNIFORM_BYTES, LOW_PASS, WORK } from './layout.ts';
import { Pick } from './pick.ts';
import { Pool } from './pool.ts';
import { testDevice } from './test-device.ts';

const SIZE = 256;
const NEAR = 0.5;
const FAR = 300;
const EYE: [number, number, number] = [8, 0, 1.5];

/** flat 1 m discs facing south, the camera's way, at these northings */
function page(northings: number[]) {
	const n = northings.length;
	const { payload } = encodePage(
		{
			count: n,
			position: Float64Array.from(northings.flatMap((y) => [8, y, 1.5])),
			rotation: Float32Array.from({ length: n * 4 }, (_, k) => (k % 4 === 0 ? 1 : 0)),
			scale: Float32Array.from({ length: n * 3 }, (_, k) => Math.log(k % 3 === 1 ? 0.01 : 0.5)),
			alpha: new Float32Array(n).fill(1),
			dc: new Float32Array(n * 3),
			sh: null
		},
		{ g: 1, i: 0, j: 0 }
	);
	return decodePage(payload, null);
}

/** the camera at EYE, south of the discs, looking north */
function frame(device: GPUDevice, buffer: GPUBuffer): Frame {
	const v = view(new Float32Array(16), EYE, 0, 0);
	const p = perspective(new Float32Array(16), Math.PI / 3, 1, NEAR, FAR);
	const u = new Float32Array(FRAME_UNIFORM_BYTES / 4);
	u.set(v, 0);
	u.set(p, 16);
	multiply(u.subarray(32, 48), p, v);
	planes(u.subarray(48, 72), u.subarray(32, 48));
	u.set(EYE, 72);
	u.set([SIZE, SIZE, (p[0] * SIZE) / 2, (p[5] * SIZE) / 2, NEAR, FAR, LOW_PASS], 76);
	device.queue.writeBuffer(buffer, 0, u);
	const camera = Float32Array.from(EYE);
	return {
		time: 0,
		width: SIZE,
		height: SIZE,
		view: v,
		proj: p,
		near: NEAR,
		far: FAR,
		camera,
		origin: [0, 0, 0]
	};
}

async function setup() {
	const device = await testDevice();
	const pool = new Pool(device, 4096);
	const buffers = frameBuffers(device, 4096, pool.slots);
	const pick = new Pick(device, pool, buffers);
	const at = frame(device, buffers.uniforms);
	/** the drawn pages as the last frame's cull would have listed them */
	const draw = (ids: number[]) => {
		pool.upload(Infinity);
		pool.draw(ids.map((id) => ({ id, factors: 0xffffffff })));
		const header = new Uint32Array(WORK.list);
		header[WORK.visible] = pool.listed;
		device.queue.writeBuffer(buffers.work, 0, header);
		const encoder = device.createCommandEncoder();
		encoder.copyBufferToBuffer(pool.list, 0, buffers.work, WORK.list * 4, pool.listed * 4);
		device.queue.submit([encoder.finish()]);
	};
	return {
		pool,
		buffers,
		draw,
		centre: () => pick.run(SIZE / 2, SIZE / 2, at),
		corner: () => pick.run(2, 2, at)
	};
}

describe('Pick', () => {
	it('finds the nearest solid splat, its layer and its face, and nothing over the sky', async () => {
		const { pool, buffers, draw, centre, corner } = await setup();
		pool.add(1, page([10, 20]), [0, 0], () => false);
		draw([1]);
		const hit = (await centre())!;
		expect(hit.depth).toBeCloseTo(10, 2);
		expect(hit.layer).toBe(0);
		// the stored rotation is a byte per component
		hit.normal.forEach((v, k) => expect(v).toBeCloseTo([0, -1, 0][k], 1));
		expect(await corner()).toBeNull();

		pool.add(-1, page([5]), [0, 0], () => false, 3);
		draw([1, -1]);
		expect(await centre()).toMatchObject({ depth: expect.closeTo(5, 2), layer: 3 });
		pool.destroy();
		buffers.destroy();
	});

	it('never finds a splat a mask hides', async () => {
		const { pool, buffers, draw, centre } = await setup();
		pool.add(1, page([10, 20]), [0, 0], () => false);
		pool.masks.add(
			{ polygon: Float64Array.from([7, 9, 9, 9, 9, 11, 7, 11]), z: [-Infinity, Infinity] },
			new Set([0])
		);
		pool.remask([7, 9, 9, 11]);
		draw([1]);
		expect((await centre())!.depth).toBeCloseTo(20, 2);
		pool.destroy();
		buffers.destroy();
	});
});
