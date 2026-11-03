import { describe, expect, it } from 'vitest';
import { CLUSTER, decodePage } from '../../format/index.ts';
import { encodePage } from '../../format/encode.ts';
import { planes } from '../math/frustum.ts';
import { multiply, perspective, view } from '../math/mat4.ts';
import type { Frame, Shade } from '../plugin.ts';
import { AttributeRegistry } from '../stream/attributes.ts';
import type { Extension } from './extension.ts';
import { frameBuffers } from './buffers.ts';
import { FRAME_UNIFORM_BYTES, LOW_PASS, PLUGIN_VEC4S, PROJECTED_WORDS, WORK } from './layout.ts';
import clip from './clip.wgsl?raw';
import masks from './masks.wgsl?raw';
import { Pick } from './pick.ts';
import { Pool } from './pool.ts';
import { ATTRIBUTES, fits, HOOKED, Project, shaded, streams, type Hooked } from './project.ts';
import projectSource from './project.wgsl?raw';
import { Raster } from './raster.ts';
import rasterSource from './raster.wgsl?raw';
import { Sort } from './sort.ts';
import splat from './splat.wgsl?raw';
import { readBuffer, testDevice } from './test-device.ts';

const SIZE = 64;
const NEAR = 0.5;
const FAR = 300;
const EYE: [number, number, number] = [8, 0, 1.5];
const RECORD_WORDS = 20;
const SOURCE = { pack: 'u/0/0/0.0123456789abcdef.pack', blob: 120 };

/** discs facing south, the camera's way, grey (0.5), 1 m across and solid unless given */
function page(discs: { at: [number, number, number]; alpha?: number; rotation?: number[] }[]) {
	const n = discs.length;
	const { payload } = encodePage(
		{
			count: n,
			position: Float64Array.from(discs.flatMap((d) => d.at)),
			rotation: Float32Array.from(discs.flatMap(({ rotation = [1, 0, 0, 0] }) => rotation)),
			scale: Float32Array.from(discs.flatMap(() => [Math.log(0.5), Math.log(0.01), Math.log(0.5)])),
			alpha: Float32Array.from(discs.map(({ alpha = 1 }) => alpha)),
			dc: new Float32Array(n * 3),
			sh: null
		},
		{ g: 1, i: 0, j: 0 }
	);
	return decodePage(payload, null);
}

/** a sample hook named name: its shade asks for every splat, or those its condition holds */
function hook(name: string, sampled: string, ask = 'true', data = 'array<u32, 8>()'): Shade {
	return {
		name,
		uniforms: 1,
		sample: true,
		wgsl: `
fn ${name}(s: ptr<function, Splat>, u: array<vec4f, 1>) {
	(*s).token = 100u + (*s).row;
	if (${ask}) {
		sample_request(s, ${data});
	}
}
fn ${name}_sample(c: Sample, u: array<vec4f, 1>) -> Sampled {
	${sampled}
}`,
		update: () => {}
	};
}

const IDENTITY = 'return Sampled(vec4f(c.colour * c.alpha, c.alpha), 7u);';

async function setup(discs: Parameters<typeof page>[0]) {
	const device = await testDevice();
	const slots = 4 * CLUSTER;
	const pool = new Pool(device, slots);
	const buffers = frameBuffers(device, slots, pool.slots);
	const project = new Project(device, pool, buffers);
	const sort = new Sort(device, buffers);
	const raster = new Raster(device, buffers, sort, pool, 'rgba32float');
	const pick = new Pick(device, pool, buffers);
	pool.add(1, page(discs), [0, 0], () => false, 0, SOURCE);
	pool.upload(Infinity);
	pool.draw([{ id: 1, factors: 0xffffffff }]);
	const target = device.createTexture({
		size: [SIZE, SIZE],
		format: 'rgba32float',
		usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
	});
	const camera = frame();
	let hooks: Hooked[] = [];

	/** a frame through hooks with room for records, its pixels and work counts */
	const render = async (shades: Shade[], records = 64, values?: Float32Array) => {
		hooks = shades.map((shade, k) => ({ shade, slot: k, streams: [] }));
		for (const pass of [project, raster, pick]) pass.hooks(hooks);
		const at = pool.extension.frame(records * RECORD_WORDS);
		pool.draw([{ id: 1, factors: 0xffffffff }]);
		pool.extension.flush();
		writeUniforms(device, buffers.uniforms, camera, {
			records: [at, records],
			tables: [pool.tables.directory, pool.tables.count]
		});
		device.queue.writeBuffer(buffers.plugins, 0, values ?? new Float32Array(PLUGIN_VEC4S * 4));
		const header = new Uint32Array(WORK.list);
		header[WORK.visible] = pool.listed;
		device.queue.writeBuffer(buffers.work, 0, header);
		const encoder = device.createCommandEncoder();
		encoder.copyBufferToBuffer(pool.list, 0, buffers.work, WORK.list * 4, pool.listed * 4);
		project.encode(encoder, pool.listed);
		sort.encode(encoder, pool.listed * CLUSTER, 0);
		raster.encode(encoder, target.createView(), null, [0, 0, 0]);
		device.queue.submit([encoder.finish()]);
		const work = new Uint32Array(await readBuffer(device, buffers.work, 0, WORK.list * 4));
		return { pixels: await texels(device, target), work };
	};

	const destroy = () => {
		target.destroy();
		pick.destroy();
		raster.destroy();
		sort.destroy();
		buffers.destroy();
		pool.destroy();
	};
	return { device, pool, buffers, render, pick, camera, destroy };
}

/** the camera at EYE, south of the discs, looking north */
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

/** FrameUniforms of the camera, with the extension words given */
function writeUniforms(
	device: GPUDevice,
	buffer: GPUBuffer,
	{ view: v, proj: p }: Frame,
	extension: { records: [number, number]; tables: [number, number] }
): void {
	const u = new Float32Array(FRAME_UNIFORM_BYTES / 4);
	u.set(v, 0);
	u.set(p, 16);
	multiply(u.subarray(32, 48), p, v);
	planes(u.subarray(48, 72), u.subarray(32, 48));
	u.set(EYE, 72);
	u.set([SIZE, SIZE, (p[0] * SIZE) / 2, (p[5] * SIZE) / 2, NEAR, FAR, LOW_PASS], 76);
	new Uint32Array(u.buffer).set([...extension.tables, ...extension.records], 84);
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

const largest = (a: Float32Array, b: Float32Array) =>
	a.reduce((most, v, k) => Math.max(most, Math.abs(v - b[k])), 0);

describe('sample hooks', () => {
	it('draw a splat unchanged through an identity hook, to 1e-5 per premultiplied channel', async () => {
		const discs = [
			{ at: [8, 10, 1.5] as [number, number, number], alpha: 0.6 },
			{ at: [8.3, 14, 1.6] as [number, number, number], alpha: 0.9 },
			{ at: [7.6, 20, 1.4] as [number, number, number] }
		];
		const { render, destroy } = await setup(discs);
		const plain = await render([]);
		const sampled = await render([hook('same', IDENTITY)]);
		expect(plain.work[WORK.sampled]).toBe(0);
		expect(sampled.work[WORK.sampled]).toBe(3);
		expect(plain.pixels.some((v, k) => k % 4 === 0 && v > 0.1)).toBe(true);
		expect(largest(sampled.pixels, plain.pixels)).toBeLessThanOrEqual(1e-5);
		destroy();
	});

	it("draw what the hook returns: half the alpha in one colour, counting the hook's coverage_over", async () => {
		const { render, destroy } = await setup([{ at: [8, 10, 1.5] }]);
		const plain = (await render([])).pixels;
		const half =
			'coverage_over();\n\treturn Sampled(vec4f(vec3f(1.0, 0.25, 0.5) * c.alpha, c.alpha) * 0.5, 0u);';
		const { pixels, work } = await render([hook('half', half)]);
		// the splat is grey, so the plain red is half its alpha; a sample under 1/255 is discarded
		let covered = 0;
		for (let k = 0; k < plain.length; k += 4) {
			const a = 2 * plain[k];
			const kept = a / 2 >= 1 / 255 ? a / 2 : 0;
			expect(Math.abs(pixels[k] - kept)).toBeLessThanOrEqual(1e-5);
			expect(Math.abs(pixels[k + 1] - kept / 4)).toBeLessThanOrEqual(1e-5);
			expect(Math.abs(pixels[k + 2] - kept / 2)).toBeLessThanOrEqual(1e-5);
			if (a >= 1 / 255) covered++;
		}
		expect(covered).toBeGreaterThan(10);
		expect(work[WORK.rasterOver]).toBe(covered);
		destroy();
	});

	it("give pick the sample's token and the shade's elsewhere, and the splat's row", async () => {
		// 1 m off the axis: 5.5 px west at 10 m, 2.8 px east at 20 m
		const discs = [
			{ at: [7, 10, 1.5] as [number, number, number] },
			{ at: [9, 20, 1.5] as [number, number, number] }
		];
		const { render, pick, camera, destroy } = await setup(discs);
		// the near disc's sample hook reports what its shade passed and its row
		const data = 'array<u32, 8>(0u, 200u, 0u, 0u, 0u, 0u, 0u, 0u)';
		const sampled = 'return Sampled(vec4f(c.colour * c.alpha, c.alpha), c.data[1] + c.row);';
		await render([hook('tokens', sampled, '(*s).depth < 15.0', data)]);
		const probes: [number, number][] = [
			[SIZE / 2 - 5.5, SIZE / 2],
			[SIZE / 2 + 2.8, SIZE / 2]
		];
		const [west, east] = await pick.run(probes, camera);
		expect(west).toMatchObject({ depth: expect.closeTo(10, 1), row: SOURCE });
		expect(east).toMatchObject({ depth: expect.closeTo(20, 1), row: SOURCE });
		expect(west!.token).toBe(200 + west!.row!.row);
		expect(east!.token).toBe(100 + east!.row!.row);
		expect(new Set([west!.row!.row, east!.row!.row])).toEqual(new Set([0, 1]));
		destroy();
	});

	it('never let a sample of no alpha be hit, so pick finds what lies behind it', async () => {
		const discs = [
			{ at: [8, 10, 1.5] as [number, number, number] },
			{ at: [8, 20, 1.5] as [number, number, number] }
		];
		const { render, pick, camera, destroy } = await setup(discs);
		const none = hook('none', 'return Sampled(vec4f(0.0), 3u);', '(*s).depth < 15.0');
		const { pixels } = await render([none]);
		const [behind] = await pick.run([[SIZE / 2, SIZE / 2]], camera);
		expect(behind).toMatchObject({ depth: expect.closeTo(20, 1) });
		expect(behind!.token).toBe(100 + behind!.row!.row);
		// the raster drew the far disc alone: under a quarter of the near one's size
		const drawn = pixels.filter((v, k) => k % 4 === 0 && v > 1 / 255).length;
		expect(drawn).toBeGreaterThan(0);
		const plain = (await render([])).pixels.filter((v, k) => k % 4 === 0 && v > 1 / 255).length;
		expect(drawn).toBeLessThan(plain / 2);
		destroy();
	});

	it('read host tables in every pass, 0 past their end, as they were last written', async () => {
		const { pool, render, pick, camera, destroy } = await setup([{ at: [8, 10, 1.5] }]);
		const table = pool.tables.create(4);
		pool.tables.create(2).destroy();
		table.write(0, new Uint32Array([11, 22, 33, 44]));
		expect(() => table.write(3, new Uint32Array([1, 2]))).toThrow(RangeError);
		// the shade reads word 2 and one past the end; the sample hook word 0 of the destroyed table
		const tabled: Shade = {
			name: 'tabled',
			uniforms: 1,
			sample: true,
			wgsl: `
fn tabled(s: ptr<function, Splat>, u: array<vec4f, 1>) {
	let id = u32(u[0].x);
	sample_request(s, array<u32, 8>(table(id, 2u) * 1000u + table(id, 4u) + table(id + 5u, 0u), 0u, 0u, 0u, 0u, 0u, 0u, 0u));
}
fn tabled_sample(c: Sample, u: array<vec4f, 1>) -> Sampled {
	return Sampled(vec4f(c.colour * c.alpha, c.alpha), c.data[0] + table(1u, 0u));
}`,
			update: () => {}
		};
		const values = new Float32Array(PLUGIN_VEC4S * 4);
		values[0] = table.id;
		await render([tabled], 64, values);
		expect((await pick.run([[SIZE / 2, SIZE / 2]], camera))[0]?.token).toBe(33000);
		table.write(2, new Uint32Array([77]));
		await render([tabled], 64, values);
		expect((await pick.run([[SIZE / 2, SIZE / 2]], camera))[0]?.token).toBe(77000);
		destroy();
	});

	it('read a record in the sample hook, in the raster and pick, from what the shade passed', async () => {
		const { pool, render, pick, camera, destroy } = await setup([{ at: [8, 10, 1.5] }]);
		pool.tables.create(4);
		// the record is table 0's directory entry: its first word, then its length, 4
		const recorded: Shade = {
			name: 'recorded',
			uniforms: 1,
			sample: true,
			wgsl: `
fn recorded(s: ptr<function, Splat>, u: array<vec4f, 1>) {
	sample_request(s, array<u32, 8>(uniforms.tables, 2u, 0u, 0u, 0u, 0u, 0u, 0u));
}
fn recorded_sample(c: Sample, u: array<vec4f, 1>) -> Sampled {
	let r = Record(c.data[0], c.data[1]);
	let grey = f32(record_u32(r, 1u)) / 8.0;
	return Sampled(vec4f(vec3f(grey) * c.alpha, c.alpha), record_u32(r, 1u) + 100u * record_u32(r, 2u));
}`,
			update: () => {}
		};
		const plain = (await render([])).pixels;
		const { pixels } = await render([recorded]);
		expect(largest(pixels, plain)).toBeLessThanOrEqual(1e-5);
		expect((await pick.run([[SIZE / 2, SIZE / 2]], camera))[0]?.token).toBe(4);
		destroy();
	});

	it('give a shade the source coordinates of a world point, along the axes as the splat turns them', async () => {
		// a quarter turn about north: axis 0 points down, axis 2 east, 0.5 m sigma each
		const turned = [Math.SQRT1_2, 0, Math.SQRT1_2, 0];
		const { render, pick, camera, destroy } = await setup([{ at: [8, 10, 1.5], rotation: turned }]);
		// 0.25 m east and 0.5 m up of the centre, as hundredths of a sigma from -8 along axes 0 and 2;
		// along the 1 cm axis the 8-bit rotation's error is tens of sigmas
		const sourced: Shade = {
			name: 'sourced',
			uniforms: 1,
			wgsl: `
fn sourced(s: ptr<function, Splat>, u: array<vec4f, 1>) {
	let z = source(s, (*s).position + vec3f(0.25, 0.0, 0.5));
	let q = vec3u(round((z + 8.0) * 100.0));
	(*s).token = q.x * 2000u + q.z;
}`,
			update: () => {}
		};
		await render([sourced]);
		const token = (await pick.run([[SIZE / 2, SIZE / 2]], camera))[0]!.token;
		expect([Math.floor(token / 2000), token % 2000]).toEqual([700, 850]);
		destroy();
	});

	it('draw a splat unsampled past the records the frame holds, counting every ask', async () => {
		const discs = [
			{ at: [7.5, 10, 1.5] as [number, number, number] },
			{ at: [8.5, 12, 1.5] as [number, number, number] }
		];
		const { device, buffers, render, destroy } = await setup(discs);
		const half = hook('half', 'return Sampled(vec4f(c.colour * c.alpha, c.alpha) * 0.5, 0u);');
		const { work } = await render([half], 1);
		expect(work[WORK.sampled]).toBe(2);
		const words = new Uint32Array(await readBuffer(device, buffers.projected));
		const tagged = [0, 1].filter((i) => words[i * PROJECTED_WORDS + 5] & 0x80000000).length;
		expect(work[WORK.projected]).toBe(2);
		expect(tagged).toBe(1);
		destroy();
	});
});

describe('attribute accessors', () => {
	const uses: Shade['attributes'] = [
		{ stream: 'a', as: 'small', type: 'u32' },
		{ stream: 'b', as: 'signed', type: 'i32', components: 2 },
		{ stream: 'c', as: 'half', type: 'f32', components: 3 },
		{ stream: 'd', as: 'full', type: 'f32', components: 4 },
		{ stream: 'e', as: 'notes', type: 'records' },
		{ stream: 'f', as: 'lacking', type: 'f32', components: 2 },
		{ stream: 'g', as: 'none', type: 'records' }
	];
	const reader: Shade = {
		name: 'reader',
		uniforms: 1,
		attributes: uses,
		wgsl: `
fn reader(s: ptr<function, Splat>, u: array<vec4f, 1>) {
	let n = attr_notes(s);
	let v = f32(attr_small(s)) + f32(attr_signed(s).y) + attr_half(s).z + attr_full(s).w + attr_lacking(s).x;
	(*s).token = record_u32(n, 0u) + u32(record_f16x2(attr_none(s), 1u).x) + u32(v);
}`,
		update: () => {}
	};
	const hooked: Hooked = {
		shade: reader,
		slot: 0,
		streams: [0, 1, 2, 3, 4, null, null]
	};

	it('compile in the projection, pick and raster against the attribute stub', async () => {
		const device = await testDevice();
		const square =
			'array<vec2f, 12>(vec2f(-1.0), vec2f(1.0, -1.0), vec2f(1.0), vec2f(-1.0, 1.0), vec2f(), vec2f(), vec2f(), vec2f(), vec2f(), vec2f(), vec2f(), vec2f())';
		const clipped = hook(
			'clipped',
			`let m = polygon(marginal(posterior(c.coverage, c.offset), 0u, 1u), ${square}, 4u);\n\treturn Sampled(vec4f(c.colour, 1.0) * c.alpha * m, 0u);`
		);
		const both: Hooked[] = [hooked, { shade: clipped, slot: 1, streams: [] }];
		const modules = [
			shaded([...HOOKED, ATTRIBUTES, masks, clip, splat, projectSource], both, 'shade'),
			// no attribute reads: the raster runs only sample hooks
			shaded([...HOOKED, rasterSource], both, 'sample')
		];
		for (const code of modules) {
			const info = await device.createShaderModule({ code }).getCompilationInfo();
			expect(info.messages.filter((m) => m.type === 'error').map((m) => m.message)).toEqual([]);
		}
	});

	it('read a stream only as it widens, and turn a hook off that lacks a stream it requires', () => {
		expect(fits({ stream: 'a', as: 'a', type: 'u32' }, { type: 'u16', components: 1 })).toBe(true);
		expect(fits({ stream: 'a', as: 'a', type: 'i32' }, { type: 'u16', components: 1 })).toBe(false);
		expect(
			fits({ stream: 'a', as: 'a', type: 'f32', components: 2 }, { type: 'f16', components: 3 })
		).toBe(false);
		expect(
			fits({ stream: 'a', as: 'a', type: 'records' }, { type: 'records', components: 0 })
		).toBe(true);
		const extension = { alloc: () => 0, write: () => {} } as unknown as Extension;
		const registry = new AttributeRegistry(extension);
		expect(streams(reader, registry)).toEqual(uses.map(() => null));
		const required = { ...reader, attributes: [{ ...uses[0], required: true }] };
		expect(streams(required, registry)).toBeNull();
	});
});
