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

/** a disc: its northing on the camera's axis, or its place; its alpha, size and turn about east */
interface Disc {
	north?: number;
	at?: [number, number, number];
	alpha?: number;
	size?: number;
	tilt?: number;
}

/** discs facing south, the camera's way, 1 m and solid unless given */
function page(discs: (number | Disc)[]) {
	const all = discs.map((d): Disc => (typeof d === 'number' ? { north: d } : d));
	const n = all.length;
	const { payload } = encodePage(
		{
			count: n,
			position: Float64Array.from(all.flatMap((d) => d.at ?? [8, d.north!, 1.5])),
			rotation: Float32Array.from(
				all.flatMap(({ tilt = 0 }) => [Math.cos(tilt / 2), Math.sin(tilt / 2), 0, 0])
			),
			scale: Float32Array.from(
				all.flatMap(({ size = 0.5 }) => [Math.log(size), Math.log(0.01), Math.log(size)])
			),
			alpha: Float32Array.from(all.map(({ alpha = 1 }) => alpha)),
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

async function setup(slots = 4096) {
	const device = await testDevice();
	const pool = new Pool(device, slots);
	const buffers = frameBuffers(device, slots, pool.slots);
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
		corner: () => pick.run(2, 2, at),
		/** the pixel whose ray climbs `slope` metres a metre north */
		above: (slope: number) => pick.run(SIZE / 2, SIZE / 2 - (slope * at.proj[5] * SIZE) / 2, at)
	};
}

describe('Pick', () => {
	it('finds the surface, its layer and its face, and nothing over the sky', async () => {
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

	it('never finds a splat the frame does not draw, as one whose centre is off the screen', async () => {
		const { pool, buffers, draw, centre } = await setup();
		// 3 m east of the camera's axis at 1 m: far past the guard band, though its spread reaches it
		pool.add(1, page([{ at: [11, 1, 1.5], size: 3 }, 10]), [0, 0], () => false);
		draw([1]);
		expect((await centre())!.depth).toBeCloseTo(10, 2);
		pool.destroy();
		buffers.destroy();
	});

	it('finds where the faint splats in front add up to half, as the frame blends them', async () => {
		const { pool, buffers, draw, centre } = await setup();
		pool.add(
			1,
			page([{ north: 10, alpha: 0.3 }, { north: 12, alpha: 0.3 }, 20]),
			[0, 0],
			() => false
		);
		draw([1]);
		// 1 - 0.7 * 0.7 = 0.51 at the second
		expect((await centre())!.depth).toBeCloseTo(12, 2);
		pool.destroy();
		buffers.destroy();
	});

	it('meets a turned splat where the ray crosses its plane, not at its centre', async () => {
		const { pool, buffers, draw, above } = await setup();
		pool.add(1, page([{ north: 10, tilt: Math.PI / 4 }]), [0, 0], () => false);
		draw([1]);
		// its plane is y - 10 = -(z - 1.5), the ray z - 1.5 = slope y
		const slope = 0.02;
		expect((await above(slope))!.depth).toBeCloseTo(10 / (1 + slope), 1);
		pool.destroy();
		buffers.destroy();
	});

	it('finds none while more splats lie over the pixel than it keeps, then grows to keep them', async () => {
		const { pool, buffers, draw, centre } = await setup(8192);
		// 5000 faint discs a centimetre apart, at an alpha a byte holds; the k-th brings it to half
		const alpha = 4 / 255;
		const k = Math.ceil(Math.log(0.5) / Math.log(1 - alpha));
		const discs = Array.from({ length: 5000 }, (_, i) => ({ north: 10 + i / 100, alpha }));
		pool.add(1, page(discs), [0, 0], () => false);
		draw([1]);
		expect(await centre()).toBeNull();
		expect((await centre())!.depth).toBeCloseTo(10 + (k - 1) / 100, 2);
		pool.destroy();
		buffers.destroy();
	});

	it('never finds a splat a mask hides', async () => {
		const { pool, buffers, draw, centre } = await setup();
		pool.add(1, page([10, 20]), [0, 0], () => false);
		pool.addMask(
			{ polygon: Float64Array.from([7, 9, 9, 9, 9, 11, 7, 11]), z: [-Infinity, Infinity] },
			new Set([0])
		);
		draw([1]);
		expect((await centre())!.depth).toBeCloseTo(20, 2);
		pool.destroy();
		buffers.destroy();
	});
});
