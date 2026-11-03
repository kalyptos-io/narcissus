import { describe, expect, it } from 'vitest';
import { CLUSTER, decodePage } from '../../format/index.ts';
import { encodePage } from '../../format/encode.ts';
import { planes } from '../math/frustum.ts';
import { multiply, perspective, view } from '../math/mat4.ts';
import type { Frame, Shade } from '../plugin.ts';
import type { Plane } from '../types.ts';
import { frameBuffers } from './buffers.ts';
import { Cull } from './cull.ts';
import { Heights } from './heights.ts';
import { FRAME_UNIFORM_BYTES, LOW_PASS, PROJECTED_WORDS, WORK } from './layout.ts';
import { Pick } from './pick.ts';
import { Pool } from './pool.ts';
import { Project } from './project.ts';
import { Raster } from './raster.ts';
import { Sort } from './sort.ts';
import * as ref from './test-coverage.ts';
import type { Vec2 } from './test-coverage.ts';
import { readBuffer, testDevice } from './test-device.ts';

const SIZE = 64;
const NEAR = 0.5;
const FAR = 300;
const EYE: [number, number, number] = [8, 0, 1.5];
const RECORD_WORDS = 20;
const RECORDS = 64;
const TARGET = 1 / 255;
/** a disc's grey */
const GREY = 0.5;

type At = [number, number, number];

/** discs of 0.5 m sigma across, 1 cm thick along facing, solid and grey */
function page(discs: { at: At; facing?: 'south' | 'up' }[]) {
	const n = discs.length;
	const thin = ({ facing = 'south' }: (typeof discs)[number]) =>
		facing === 'south' ? [0.5, 0.01, 0.5] : [0.5, 0.5, 0.01];
	const { payload } = encodePage(
		{
			count: n,
			position: Float64Array.from(discs.flatMap((d) => d.at)),
			rotation: Float32Array.from(discs.flatMap(() => [1, 0, 0, 0])),
			scale: Float32Array.from(discs.flatMap((d) => thin(d).map(Math.log))),
			alpha: new Float32Array(n).fill(1),
			dc: new Float32Array(n * 3),
			sh: null
		},
		{ g: 1, i: 0, j: 0 }
	);
	return decodePage(payload, null);
}

/** the camera at EYE looking north */
function frame(): Frame {
	return {
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
}

async function setup(discs: Parameters<typeof page>[0]) {
	const device = await testDevice();
	const slots = 4 * CLUSTER;
	const pool = new Pool(device, slots);
	const buffers = frameBuffers(device, slots, pool.slots);
	const cull = new Cull(device, pool, buffers);
	const project = new Project(device, pool, buffers);
	const sort = new Sort(device, buffers);
	const raster = new Raster(device, buffers, sort, pool, 'rgba32float');
	const pick = new Pick(device, pool, buffers);
	pool.add(1, page(discs), [0, 0], () => false);
	pool.upload(Infinity);
	const target = device.createTexture({
		size: [SIZE, SIZE],
		format: 'rgba32float',
		usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
	});
	const camera = frame();
	const hooks = (shades: Shade[]) => {
		const hooked = shades.map((shade, k) => ({ shade, slot: k, streams: [] }));
		for (const pass of [project, raster, pick]) pass.hooks(hooked);
	};

	/** a frame through cull, project, sort and raster: its pixels, work counts, records and splats */
	const render = async () => {
		const at = pool.extension.frame(RECORDS * RECORD_WORDS);
		pool.draw([{ id: 1, factors: 0xffffffff }]);
		pool.extension.flush();
		writeUniforms(device, buffers.uniforms, camera, pool, [at, RECORDS]);
		const encoder = device.createCommandEncoder();
		encoder.clearBuffer(buffers.work, 0, WORK.list * 4);
		cull.encode(encoder);
		project.encode(encoder, pool.listed);
		sort.encode(encoder, pool.listed * CLUSTER, 0);
		raster.encode(encoder, target.createView(), null, [0, 0, 0]);
		device.queue.submit([encoder.finish()]);
		const work = new Uint32Array(await readBuffer(device, buffers.work, 0, WORK.list * 4));
		const records = await readBuffer(
			device,
			pool.extension.buffer,
			at * 4,
			RECORDS * RECORD_WORDS * 4
		);
		const projected = await readBuffer(device, buffers.projected);
		return { pixels: await texels(device, target), work, records, projected };
	};

	const heights = async (x: number, y: number, cells: number) => {
		pool.draw([{ id: 1, factors: 0xffffffff }]);
		const encoder = device.createCommandEncoder();
		const read = new Heights(device, pool).encode(encoder, x, y, cells);
		device.queue.submit([encoder.finish()]);
		return (await read())!;
	};

	const destroy = () => {
		target.destroy();
		pick.destroy();
		raster.destroy();
		sort.destroy();
		buffers.destroy();
		pool.destroy();
	};
	return { pool, render, hooks, heights, pick, camera, destroy };
}

/** FrameUniforms of the camera, with the pool's tables and clips and the records given */
function writeUniforms(
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

/** rgba of every texel, row by row from the top-left */
async function texels(device: GPUDevice, texture: GPUTexture): Promise<Float32Array> {
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

/** record r as a coverage and its clip planes, f16 as the raster reads them */
function recordOf(records: ArrayBuffer, r: number) {
	const view = new DataView(records, r * RECORD_WORDS * 4);
	const half = (word: number, k: number) => view.getFloat16(word * 4 + 2 * k, true);
	const pair = (word: number): Vec2 => [half(word, 0), half(word, 1)];
	const coverage: ref.Coverage = { b: [pair(0), pair(1), pair(2)], low: half(7, 1) };
	const planes = [16, 18]
		.map((w) => [half(w, 0), half(w, 1), half(w + 1, 0), half(w + 1, 1)])
		.filter((p) => p.slice(0, 3).some((v) => v !== 0));
	return { coverage, planes };
}

/** the centre of projected splat i, pixels with y up */
function centreOf(projected: ArrayBuffer, i: number): Vec2 {
	const f = new Float32Array(projected, i * PROJECTED_WORDS * 4, 2);
	return [f[0], f[1]];
}

/** each pixel's index in the texels and its centre less the splat's, y up */
function* offsets(centre: Vec2) {
	for (let row = 0; row < SIZE; row++)
		for (let col = 0; col < SIZE; col++) {
			const offset: Vec2 = [col + 0.5 - centre[0], SIZE - row - 0.5 - centre[1]];
			yield { k: 4 * (row * SIZE + col), offset };
		}
}

/** the convex polygon v cut to where n . q + d >= 0 */
function halfplane(v: Vec2[], n: Vec2, d: number): Vec2[] {
	const f = ([x, y]: Vec2) => n[0] * x + n[1] * y + d;
	const out: Vec2[] = [];
	v.forEach((p, i) => {
		const q = v[(i + 1) % v.length];
		if (f(p) >= 0) out.push(p);
		if (f(p) >= 0 !== f(q) >= 0) {
			const t = f(p) / (f(p) - f(q));
			out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
		}
	});
	return out;
}

/** whether the raster's 1/255 discard leaves pixel k as the reference, not within tolerance of it */
const settled = (alpha: number, tolerance: number) => Math.abs(alpha - TARGET) > tolerance;

const sum = (pixels: Float32Array) => pixels.reduce((s, v, k) => (k % 4 === 0 ? s + v : s), 0);

describe('clips', () => {
	it('keep half the mass of a splat a plane halves, and a quarter at two', async () => {
		const { pool, render, destroy } = await setup([{ at: [8, 10, 1.5] }]);
		const plain = await render();
		expect(plain.work[WORK.sampled]).toBe(0);
		const total = sum(plain.pixels);
		expect(total).toBeGreaterThan(10);
		const cases: [Plane[], number][] = [
			[[[1, 0, 0, -8]], 0.5],
			[
				[
					[1, 0, 0, -8],
					[0, 0, 2, -3]
				],
				0.25
			]
		];
		for (const [planes, share] of cases) {
			const id = pool.clips.add(planes);
			const { pixels, work, records, projected } = await render();
			expect(work[WORK.sampled]).toBe(1);
			expect(Math.abs(sum(pixels) / total - share)).toBeLessThan(TARGET);
			// each pixel against the textbook posterior's mass on the record's own inputs
			const { coverage, planes: crossing } = recordOf(records, 0);
			expect(crossing).toHaveLength(planes.length);
			for (const { k, offset } of offsets(centreOf(projected, 0))) {
				const p = ref.posterior(coverage, offset);
				// the disc's own plane: its thin axis 1 left out
				const kept = ref.dense(
					ref.marginal(p, 0, 2),
					crossing.reduce((v, [x, , z, d]) => halfplane(v, [x, z], d), [
						[-9, -9],
						[9, -9],
						[9, 9],
						[-9, 9]
					] as Vec2[])
				);
				const base = plain.pixels[k] / GREY;
				const alpha = base * kept;
				const tolerance = base * TARGET + 1e-5;
				if (!settled(alpha, tolerance)) continue;
				const expected = alpha >= TARGET ? GREY * alpha : 0;
				expect(Math.abs(pixels[k] - expected)).toBeLessThanOrEqual(GREY * tolerance);
			}
			pool.clips.delete(id);
		}
		destroy();
	});

	it('cull a splat wholly outside a plane, and never pick it', async () => {
		const near = { at: [8, 10, 1.5] as At };
		const far = { at: [8, 20, 1.5] as At };
		const cut: Plane[] = [[0, 1, 0, -15]];

		const alone = await setup([near]);
		alone.pool.clips.add(cut);
		const { work, pixels } = await alone.render();
		expect(work[WORK.visible]).toBe(0);
		expect(pixels.every((v, k) => k % 4 === 3 || v === 0)).toBe(true);
		expect(await alone.pick.run([[SIZE / 2, SIZE / 2]], alone.camera)).toEqual([null]);
		alone.destroy();

		const both = await setup([near, far]);
		const unclipped = await both.render();
		const [front] = await both.pick.run([[SIZE / 2, SIZE / 2]], both.camera);
		expect(front).toMatchObject({ depth: expect.closeTo(10, 1) });
		both.pool.clips.add(cut);
		const clipped = await both.render();
		expect(unclipped.work[WORK.projected]).toBe(2);
		expect(clipped.work[WORK.visible]).toBe(1);
		expect(clipped.work[WORK.projected]).toBe(1);
		expect(clipped.work[WORK.sampled]).toBe(0);
		const [behind] = await both.pick.run([[SIZE / 2, SIZE / 2]], both.camera);
		expect(behind).toMatchObject({ depth: expect.closeTo(20, 1) });
		both.destroy();
	});

	it("with a sample hook's polygon, keep the mass of their intersection, not the product", async () => {
		const { pool, render, hooks, pick, camera, destroy } = await setup([{ at: [8, 6, 1.5] }]);
		const plain = await render();
		const vertices = (v: Vec2[]) =>
			`array<vec2f, 12>(${[...v, ...Array(12 - v.length).fill([0, 0])].map(([x, y]) => `vec2f(${x}, ${y})`).join(', ')})`;
		const square: Vec2[] = [
			[-50, -50],
			[50, -50],
			[50, 50],
			[-50, 50]
		];
		// draws the region's share of what the clip keeps, its token where it holds the most
		const part = (region: Vec2[]): Shade => ({
			name: 'part',
			uniforms: 1,
			sample: true,
			wgsl: `
fn part(s: ptr<function, Splat>, u: array<vec4f, 1>) {
	sample_request(s, array<u32, 8>());
}
fn part_sample(c: Sample, u: array<vec4f, 1>) -> Sampled {
	let p = posterior(c.coverage, c.offset);
	let q = marginal(p, 0u, 2u);
	var r = ${vertices(region)};
	let n = clip_polygon(p, 0u, 2u, c.clip, &r, ${region.length}u);
	var w = ${vertices(square)};
	let m = clip_polygon(p, 0u, 2u, c.clip, &w, 4u);
	let share = polygon(q, r, n) / max(polygon(q, w, m), 1e-30);
	return Sampled(vec4f(c.colour, 1.0) * c.alpha * share, select(1u, 2u, share > 0.5));
}`,
			update: () => {}
		});
		// sigmas along x and z in the disc's plane: a triangle, and a rectangle the plane leaves a
		// sliver of about one posterior sigma
		const regions: Vec2[][] = [
			[
				[-1.5, -1],
				[1.8, -0.4],
				[-0.2, 1.8]
			],
			[
				[-1.5, -1.2],
				[0.46, -1.2],
				[0.46, 1.2],
				[-1.5, 1.2]
			]
		];
		let wrong = 0;
		for (const region of regions) {
			hooks([part(region)]);
			const id = pool.clips.add([[1, 0, 0, -8.2]]);
			const { pixels, records, projected } = await render();
			const { coverage, planes: crossing } = recordOf(records, 0);
			expect(crossing).toHaveLength(1);
			const [x, , z, d] = crossing[0];
			let checked = 0;
			for (const { k, offset } of offsets(centreOf(projected, 0))) {
				const p = ref.marginal(ref.posterior(coverage, offset), 0, 2);
				const both = ref.dense(p, halfplane(region, [x, z], d));
				const product = ref.dense(p, halfplane(square, [x, z], d)) * ref.dense(p, region);
				const base = plain.pixels[k] / GREY;
				const tolerance = base * TARGET + 1e-5;
				if (base * Math.abs(product - both) > tolerance) wrong++;
				if (!settled(base * both, tolerance)) continue;
				const expected = base * both >= TARGET ? GREY * base * both : 0;
				expect(Math.abs(pixels[k] - expected)).toBeLessThanOrEqual(GREY * tolerance);
				if (expected > 0) checked++;
			}
			expect(checked).toBeGreaterThan(10);
			if (region === regions[0]) {
				// pick reports the hook's token in the triangle, 0.43 m east, and nothing 0.65 m west
				const [hit] = await pick.run([[SIZE / 2 + 4, SIZE / 2]], camera);
				expect(hit?.token).toBe(2);
				expect(await pick.run([[SIZE / 2 - 6, SIZE / 2]], camera)).toEqual([null]);
			}
			pool.clips.delete(id);
		}
		// the product of the two masses would fail this test
		expect(wrong).toBeGreaterThan(10);
		destroy();
	});

	it('leave out of heights a surface the clips remove', async () => {
		const { pool, heights, destroy } = await setup([
			{ at: [5.5, 5.5, 1], facing: 'up' },
			{ at: [5.5, 5.5, 6], facing: 'up' }
		]);
		expect((await heights(5, 5, 1))[0]).toBeCloseTo(6, 1);
		pool.clips.add([[0, 0, -1, 3]]);
		expect((await heights(5, 5, 1))[0]).toBeCloseTo(1, 1);
		destroy();
	});

	it('draw a frame no plane reaches bit for bit as one with no clip', async () => {
		const discs = [{ at: [8, 10, 1.5] as At }, { at: [7.6, 20, 1.4] as At }];
		const { pool, render, pick, camera, destroy } = await setup(discs);
		const probes: [number, number][] = [
			[SIZE / 2, SIZE / 2],
			[SIZE / 2 + 3, SIZE / 2 - 1]
		];
		const plain = await render();
		const picked = await pick.run(probes, camera);
		const id = pool.clips.add([
			[1, 0, 0, 100],
			[0, 1, 0, 0]
		]);
		const kept = await render();
		expect(kept.work[WORK.sampled]).toBe(0);
		expect(kept.work.slice(0, WORK.list)).toEqual(plain.work.slice(0, WORK.list));
		expect(kept.pixels).toEqual(plain.pixels);
		expect(await pick.run(probes, camera)).toEqual(picked);
		pool.clips.delete(id);
		expect((await render()).pixels).toEqual(plain.pixels);
		destroy();
	});
});
