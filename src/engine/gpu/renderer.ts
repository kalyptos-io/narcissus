// one frame on the gpu: cull, project, sort, raster, posts, present

import { CLUSTER } from '../../format/index.ts';
import { FRAME_UNIFORM_BYTES, LOW_PASS, PLUGIN_VEC4S, WORK } from './layout.ts';
import { multiply } from '../math/mat4.ts';
import type { Frame, Post, PostPass, Shade } from '../plugin.ts';
import { frameBuffers, type FrameBuffers } from './buffers.ts';
import { Cull } from './cull.ts';
import type { Gpu } from './device.ts';
import { Heights } from './heights.ts';
import type { Pool } from './pool.ts';
import type { Fullscreen } from './fullscreen.ts';
import { present } from './present.ts';
import { Project } from './project.ts';
import { COLOUR_FORMAT, DEPTH_FORMAT, depthAt, Raster } from './raster.ts';
import { Sort } from './sort.ts';
import { Timing } from './timing.ts';

export interface GpuStats {
	gpuMs: number;
	passes: Record<string, number>;
	/** splats projected, last frame read back */
	drawn: number;
	bytes: number;
}

const PASSES = ['cull', 'project', 'sort', 'raster', 'heights', 'post'];
// float offsets of FrameUniforms fields in common.wgsl
const U = {
	view: 0,
	proj: 16,
	viewProj: 32,
	planes: 48,
	camera: 72,
	time: 75,
	viewport: 76,
	focal: 78,
	near: 80,
	far: 81,
	lowPass: 82,
	clusters: 83
};

type TargetName = 'colour' | 'depth' | 'ping' | 'pong';

/** view depth in metres of the nearest splat under target pixel (x, y from the top-left), null where none drew */
export interface DepthPick {
	x: number;
	y: number;
	resolve: (depth: number | null) => void;
}

/** Heights over cells x cells from corner (x, y), floating-origin frame */
export interface HeightsRequest {
	x: number;
	y: number;
	cells: number;
	resolve: (tops: Float32Array | null) => void;
}

export class Renderer {
	#device: GPUDevice;
	#context: GPUCanvasContext;
	#format: GPUTextureFormat;
	#pool: Pool;
	#buffers: FrameBuffers;
	#cull: Cull;
	#project: Project;
	#sort: Sort;
	#raster: Raster;
	#present: Fullscreen | undefined;
	#heights: Heights;
	#timing: Timing;
	#uniforms = new Float32Array(FRAME_UNIFORM_BYTES / 4);
	#uniformWords = new Uint32Array(this.#uniforms.buffer);
	#viewProj = new Float32Array(16);
	#plugins = new Float32Array(PLUGIN_VEC4S * 4);
	#shades: { shade: Shade; slot: number }[] = [];
	#posts: { post: Post; pass: PostPass }[] = [];
	#targets: Partial<Record<TargetName, GPUTexture>> = {};
	/** one view per target, so bind groups over it last as long as the target */
	#views = new WeakMap<GPUTexture, GPUTextureView>();
	#width: number;
	#height: number;
	#count: GPUBuffer;
	#counting = false;
	#drawn = 0;

	/**
	 * capacity is the splats one frame may project; frames write the canvas of context, whose
	 * size the engine sets
	 */
	constructor(gpu: Gpu, context: GPUCanvasContext, pool: Pool, capacity: number) {
		const { device } = gpu;
		this.#device = device;
		this.#context = context;
		this.#format = gpu.format;
		this.#pool = pool;
		this.#buffers = frameBuffers(device, capacity, pool.slots);
		this.#cull = new Cull(device, pool, this.#buffers);
		this.#project = new Project(device, pool, this.#buffers);
		this.#sort = new Sort(device, this.#buffers);
		this.#raster = new Raster(device, this.#buffers, this.#sort);
		this.#heights = new Heights(device, pool);
		this.#timing = new Timing(device, gpu.timestamps, PASSES);
		this.#count = device.createBuffer({
			label: 'drawn readback',
			size: 4,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		this.#width = Math.max(1, context.canvas.width);
		this.#height = Math.max(1, context.canvas.height);
	}

	shade(hook: Shade): () => void {
		const used = this.#shades.reduce((sum, { shade }) => sum + shade.uniforms, 0);
		if (used + hook.uniforms > PLUGIN_VEC4S) {
			throw new Error(`Shade hooks may use ${PLUGIN_VEC4S} uniform slots in all.`);
		}
		const entry = { shade: hook, slot: 0 };
		this.#shades.push(entry);
		this.#hooks();
		return () => {
			const k = this.#shades.indexOf(entry);
			if (k < 0) return;
			this.#shades.splice(k, 1);
			this.#hooks();
		};
	}

	post(pass: Post): () => void {
		const entry = { post: pass, pass: pass.setup(this.#device, this.#format) };
		const order = pass.order ?? 0;
		const k = this.#posts.findIndex(({ post }) => (post.order ?? 0) > order);
		this.#posts.splice(k < 0 ? this.#posts.length : k, 0, entry);
		return () => {
			const k = this.#posts.indexOf(entry);
			if (k < 0) return;
			this.#posts.splice(k, 1);
			entry.pass.destroy();
		};
	}

	/** render target size in pixels */
	resize(width: number, height: number): void {
		if (width === this.#width && height === this.#height) return;
		this.#width = width;
		this.#height = height;
		this.#dropTargets();
	}

	/** encodes and submits a frame that answers picks and heights; resolves when the gpu has finished it */
	render(
		frame: Frame,
		planes: Float32Array,
		sky: readonly [number, number, number],
		picks: DepthPick[],
		heights: HeightsRequest[]
	): Promise<void> {
		const device = this.#device;
		const timing = this.#timing;
		const posts = this.#posts;
		const colour = this.#view(this.#target('colour', COLOUR_FORMAT));
		const wantDepth = picks.length > 0 || posts.some(({ post }) => post.depth);
		const depthTexture = this.#optional('depth', DEPTH_FORMAT, wantDepth);
		const depth = depthTexture ? this.#view(depthTexture) : null;
		const ping = [
			this.#optional('ping', this.#format, posts.length > 1),
			this.#optional('pong', this.#format, posts.length > 2)
		];
		this.#upload(frame, planes);

		const encoder = device.createCommandEncoder({ label: 'frame' });
		encoder.clearBuffer(this.#buffers.work, 0, WORK.list * 4);
		this.#cull.encode(encoder, timing.writes('cull'));
		this.#project.encode(encoder, timing.writes('project'));
		this.#sort.encode(encoder, this.#pool.listed * CLUSTER, this.#drawn, timing.writes('sort'));
		this.#raster.encode(encoder, colour, depth, sky, timing.writes('raster'));
		const reads = depthTexture
			? picks.map(({ x, y, resolve }) => ({
					resolve,
					read: depthAt(device, encoder, depthTexture, x, y, frame.near, frame.far)
				}))
			: [];
		const tops = heights.map(({ x, y, cells, resolve }, k) => ({
			resolve,
			read: this.#heights.encode(encoder, x, y, cells, k ? undefined : timing.writes('heights'))
		}));

		// present and posts take no timestamp writes, so empty passes bracket them
		const bracket = timing.writes('post');
		if (bracket) {
			const { querySet, beginningOfPassWriteIndex } = bracket;
			encoder.beginComputePass({ timestampWrites: { querySet, beginningOfPassWriteIndex } }).end();
		}
		const canvas = this.#context.getCurrentTexture().createView();
		if (!posts.length) {
			this.#present ??= present(device, this.#format);
			this.#present.encode(encoder, [colour], canvas);
		} else {
			let input = colour;
			posts.forEach(({ post, pass }, k) => {
				const target = k === posts.length - 1 ? canvas : this.#view(ping[k % 2]!);
				pass.run(encoder, frame, input, post.depth ? depth : null, target);
				input = target;
			});
		}
		if (bracket) {
			const { querySet, endOfPassWriteIndex } = bracket;
			encoder.beginComputePass({ timestampWrites: { querySet, endOfPassWriteIndex } }).end();
		}

		timing.resolve(encoder);
		const count = !this.#counting;
		if (count) {
			encoder.copyBufferToBuffer(this.#buffers.work, WORK.projected * 4, this.#count, 0, 4);
		}
		device.queue.submit([encoder.finish()]);
		timing.read();
		if (count) this.#readCount();
		for (const { resolve, read } of reads) void read().then(resolve);
		for (const { resolve, read } of tops) void read().then(resolve);
		return device.queue.onSubmittedWorkDone();
	}

	stats(): GpuStats {
		const passes = { ...this.#timing.ms };
		let bytes = this.#buffers.bytes + this.#sort.bytes;
		for (const texture of Object.values(this.#targets)) {
			if (!texture) continue;
			bytes += texture.width * texture.height * (texture.format === DEPTH_FORMAT ? 2 : 4);
		}
		return {
			gpuMs: Object.values(passes).reduce((sum, ms) => sum + ms, 0),
			passes,
			drawn: this.#drawn,
			bytes
		};
	}

	destroy(): void {
		for (const { pass } of this.#posts.splice(0)) pass.destroy();
		this.#dropTargets();
		this.#buffers.destroy();
		this.#sort.destroy();
		this.#raster.destroy();
		this.#timing.destroy();
		this.#count.destroy();
	}

	#hooks(): void {
		let next = 0;
		for (const entry of this.#shades) {
			entry.slot = next;
			next += entry.shade.uniforms;
		}
		this.#project.hooks(this.#shades);
	}

	#upload(frame: Frame, planes: Float32Array): void {
		const u = this.#uniforms;
		const [w, h] = [this.#width, this.#height];
		u.set(frame.view, U.view);
		u.set(frame.proj, U.proj);
		u.set(multiply(this.#viewProj, frame.proj, frame.view), U.viewProj);
		u.set(planes, U.planes);
		u.set(frame.camera.subarray(0, 3), U.camera);
		u[U.time] = frame.time;
		u.set([w, h], U.viewport);
		u.set([(frame.proj[0] * w) / 2, (frame.proj[5] * h) / 2], U.focal);
		u[U.near] = frame.near;
		u[U.far] = frame.far;
		u[U.lowPass] = LOW_PASS;
		this.#uniformWords[U.clusters] = this.#pool.listed;
		this.#device.queue.writeBuffer(this.#buffers.uniforms, 0, u);

		for (const { shade, slot } of this.#shades) {
			shade.update(frame, this.#plugins.subarray(slot * 4, (slot + shade.uniforms) * 4));
		}
		if (this.#shades.length)
			this.#device.queue.writeBuffer(this.#buffers.plugins, 0, this.#plugins);
	}

	#target(name: TargetName, format: GPUTextureFormat): GPUTexture {
		let texture = this.#targets[name];
		if (!texture) {
			texture = this.#device.createTexture({
				label: name,
				size: [this.#width, this.#height],
				format,
				usage:
					GPUTextureUsage.RENDER_ATTACHMENT |
					GPUTextureUsage.TEXTURE_BINDING |
					GPUTextureUsage.COPY_SRC
			});
			this.#targets[name] = texture;
		}
		return texture;
	}

	#view(texture: GPUTexture): GPUTextureView {
		let view = this.#views.get(texture);
		if (!view) this.#views.set(texture, (view = texture.createView()));
		return view;
	}

	#optional(name: TargetName, format: GPUTextureFormat, wanted: boolean): GPUTexture | undefined {
		if (wanted) return this.#target(name, format);
		this.#targets[name]?.destroy();
		delete this.#targets[name];
		return undefined;
	}

	#dropTargets(): void {
		for (const texture of Object.values(this.#targets)) texture?.destroy();
		this.#targets = {};
	}

	#readCount(): void {
		this.#counting = true;
		const buffer = this.#count;
		// the map rejects once destroyed or the device is lost
		buffer
			.mapAsync(GPUMapMode.READ)
			.then(() => {
				const projected = new Uint32Array(buffer.getMappedRange())[0];
				this.#drawn = Math.min(projected, this.#buffers.capacity);
				buffer.unmap();
			})
			.catch(() => {})
			.finally(() => (this.#counting = false));
	}
}
