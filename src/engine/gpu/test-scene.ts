// a page drawn through project, sort and raster into a float target, for the hook and clip tests

import { CLUSTER, type DecodedPage } from '../../format/index.ts';
import { planes } from '../math/frustum.ts';
import { multiply, perspective, view } from '../math/mat4.ts';
import type { Frame } from '../plugin.ts';
import { frameBuffers } from './buffers.ts';
import { FRAME_UNIFORM_BYTES, LOW_PASS } from './layout.ts';
import { Pick } from './pick.ts';
import { Pool, type PageSource } from './pool.ts';
import { Project } from './project.ts';
import { Raster } from './raster.ts';
import { Sort } from './sort.ts';
import { readBuffer, testDevice } from './test-device.ts';

export const SIZE = 64;
export const NEAR = 0.5;
export const FAR = 300;
export const EYE: [number, number, number] = [8, 0, 1.5];

/** page as unit 1 of a pool, the passes over it, a SIZE square target and the camera at EYE looking north */
export async function scene(page: DecodedPage, source: PageSource | null = null) {
	const device = await testDevice();
	const slots = 4 * CLUSTER;
	const pool = new Pool(device, slots);
	const buffers = frameBuffers(device, slots, pool.slots);
	const project = new Project(device, pool, buffers);
	const sort = new Sort(device, buffers);
	const raster = new Raster(device, buffers, sort, pool, 'rgba32float');
	const pick = new Pick(device, pool, buffers);
	pool.add(1, page, [0, 0], () => false, 0, source);
	pool.upload(Infinity);
	const target = device.createTexture({
		size: [SIZE, SIZE],
		format: 'rgba32float',
		usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
	});
	const camera: Frame = {
		time: 0,
		width: SIZE,
		height: SIZE,
		view: view(new Float32Array(16), EYE, 0, 0),
		proj: perspective(new Float32Array(16), Math.PI / 3, 1, NEAR, FAR),
		near: NEAR,
		far: FAR,
		camera: Float32Array.from(EYE),
		origin: [0, 0, 0]
	};
	const destroy = () => {
		target.destroy();
		pick.destroy();
		raster.destroy();
		sort.destroy();
		buffers.destroy();
		pool.destroy();
	};
	return { device, pool, buffers, project, sort, raster, pick, target, camera, destroy };
}

/** FrameUniforms of the camera, with the pool's clusters, tables and clips and the records given */
export function writeUniforms(
	device: GPUDevice,
	buffer: GPUBuffer,
	{ view: v, proj: p }: Frame,
	pool: Pool,
	records: [number, number]
): void {
	const u = new Float32Array(FRAME_UNIFORM_BYTES / 4);
	u.set(v, 0);
	u.set(p, 16);
	multiply(u.subarray(32, 48), p, v);
	planes(u.subarray(48, 72), u.subarray(32, 48));
	u.set(EYE, 72);
	u.set([SIZE, SIZE, (p[0] * SIZE) / 2, (p[5] * SIZE) / 2, NEAR, FAR, LOW_PASS], 76);
	const words = new Uint32Array(u.buffer);
	words[83] = pool.listed;
	words.set([pool.tables.directory, pool.tables.count, ...records], 84);
	words.set([pool.clips.at, pool.clips.count], 88);
	device.queue.writeBuffer(buffer, 0, u);
}

/** rgba of every texel of a SIZE square target, row by row from the top-left */
export async function texels(device: GPUDevice, texture: GPUTexture): Promise<Float32Array> {
	const buffer = device.createBuffer({
		size: SIZE * SIZE * 16,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
	});
	const encoder = device.createCommandEncoder();
	encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: SIZE * 16 }, [SIZE, SIZE]);
	device.queue.submit([encoder.finish()]);
	const data = new Float32Array(await readBuffer(device, buffer));
	buffer.destroy();
	return data;
}
