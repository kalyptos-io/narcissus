// the surface under pixels as the last frame showed it: where the splats it drew over each,
// blended front to back, first reach half

import type { Frame } from '../plugin.ts';
import { planes } from '../math/frustum.ts';
import { multiply } from '../math/mat4.ts';
import { bufferLayout, liveGroup, type FrameBuffers } from './buffers.ts';
import source from './pick.wgsl?raw';
import type { PageSource, Pool } from './pool.ts';
import { HookedPipeline, type Hooked } from './project.ts';

/** workgroups of a pick, pick.wgsl's PICK_GROUPS */
const GROUPS = 256;
/** pixels one dispatch probes, at most pick.wgsl's workgroup size; a longer batch runs in several */
export const PROBES = 64;
/** bytes of pick.wgsl's Probes before its items, and of each Probe */
const PROBES_HEAD_BYTES = 16;
const PROBE_BYTES = 80;
/** bytes of pick.wgsl's Hits before its entries, and of each Entry */
const HEAD_BYTES = 16;
const ENTRY_BYTES = 48;
/** entries a pick keeps at first; one that counts more grows the buffer for the next */
const ENTRIES = 4096;
/** the share of the pixel the splats in front cover where the surface is */
const SURFACE = 0.5;
const CLEAR = new Uint32Array([0]);

export interface Found {
	/** view depth, metres */
	depth: number;
	/** 0 for the world */
	layer: number;
	/** the host's object id, 0 for none */
	object: number;
	/** the splat's thinnest axis, toward the camera */
	normal: [number, number, number];
	/** what the shade, or the sample hook there, gave the splat */
	token: number;
	/** the splat's row in its page, null for a layer's */
	row: (PageSource & { row: number }) | null;
}

export class Pick {
	#device: GPUDevice;
	#pool: Pool;
	#pipeline: HookedPipeline;
	#viewProj = new Float32Array(16);
	#planes = new Float32Array(24);
	#values = new Float32Array((PROBES_HEAD_BYTES + PROBES * PROBE_BYTES) / 4);
	#probes: GPUBuffer;
	#entries = 0;
	#hits!: GPUBuffer;
	#group: () => GPUBindGroup;

	constructor(device: GPUDevice, pool: Pool, buffers: FrameBuffers) {
		this.#device = device;
		this.#pool = pool;
		const layout = bufferLayout(device, 'pick', GPUShaderStage.COMPUTE, [
			'uniform',
			'uniform',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'storage',
			'read-only-storage'
		]);
		const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
		this.#pipeline = new HookedPipeline(device, pipelineLayout, source, 'pick', 'gather');
		// picks in flight share these: the queue runs each pick's writes after the last one's pass
		this.#probes = device.createBuffer({
			label: 'pick probes',
			size: this.#values.byteLength,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		const { uniforms, plugins, work } = buffers;
		const { geometry, colour, pages, clusters } = pool;
		const fixed = [uniforms, plugins, geometry, colour, pages, clusters, work, this.#probes];
		this.#group = liveGroup(device, 'pick', layout, () => [
			...fixed,
			this.#hits,
			pool.extension.buffer
		]);
		this.#grow(ENTRIES);
	}

	/** the next pick runs these hooks, as project does */
	hooks(hooks: readonly Hooked[]): void {
		this.#pipeline.hooks(hooks);
	}

	/**
	 * submits picks of target pixels (x, y from the top-left) over the frame's visible clusters, one
	 * dispatch a batch of PROBES; frame must be the last one submitted, whose uniforms and cull the
	 * buffers still hold. null where the splats over a pixel never reach half; undefined over a whole
	 * batch where more lay under its pixels than the buffer kept, which grows it for the next
	 */
	run(
		pixels: readonly (readonly [number, number])[],
		frame: Frame
	): Promise<(Found | null | undefined)[]> {
		const batches: Promise<(Found | null | undefined)[]>[] = [];
		for (let k = 0; k < pixels.length; k += PROBES)
			batches.push(this.#batch(pixels.slice(k, k + PROBES), frame));
		return Promise.all(batches).then((found) => found.flat());
	}

	destroy(): void {
		this.#probes.destroy();
		this.#hits.destroy();
	}

	#batch(
		pixels: readonly (readonly [number, number])[],
		frame: Frame
	): Promise<(Found | null | undefined)[]> {
		const device = this.#device;
		const pool = this.#pool;
		const kept = this.#entries;
		const bytes = HEAD_BYTES + kept * ENTRY_BYTES;
		const readback = device.createBuffer({
			label: 'pick readback',
			size: bytes,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		const values = this.#values;
		new Uint32Array(values.buffer, 0, 1)[0] = pixels.length;
		multiply(this.#viewProj, frame.proj, frame.view);
		pixels.forEach(([x, y], k) => {
			const at = (PROBES_HEAD_BYTES + k * PROBE_BYTES) / 4;
			const up = frame.height - y;
			values.set([x, up], at);
			values.set(this.#sides(x, up, frame), at + 4);
		});
		const used = PROBES_HEAD_BYTES + pixels.length * PROBE_BYTES;
		device.queue.writeBuffer(this.#probes, 0, values.buffer, 0, used);
		device.queue.writeBuffer(this.#hits, 0, CLEAR);

		// the pages as the gpu reads them now: the pool may evict some before the answer
		const sources = pool.sources();
		const encoder = device.createCommandEncoder({ label: 'pick' });
		const pass = encoder.beginComputePass({ label: 'pick' });
		pass.setBindGroup(0, this.#group());
		pass.setPipeline(this.#pipeline.pipeline);
		pass.dispatchWorkgroups(GROUPS);
		pass.end();
		encoder.copyBufferToBuffer(this.#hits, 0, readback, 0, bytes);
		device.queue.submit([encoder.finish()]);
		return readback
			.mapAsync(GPUMapMode.READ)
			.then(
				() => {
					const read = readback.getMappedRange();
					const count = new Uint32Array(read, 0, 1)[0];
					if (count > kept) {
						this.#grow(2 ** Math.ceil(Math.log2(count)));
						return pixels.map(() => undefined);
					}
					const floats = new Float32Array(read, HEAD_BYTES);
					const words = new Uint32Array(read, HEAD_BYTES);
					return surfaces(floats, words, count, pixels.length, sources);
				},
				() => pixels.map(() => null)
			)
			.finally(() => readback.destroy());
	}

	/** a gather buffer of `entries`, picks in flight keeping theirs: each copied out on its own */
	#grow(entries: number): void {
		const old = this.#hits;
		this.#entries = entries;
		this.#hits = this.#device.createBuffer({
			label: 'pick',
			size: HEAD_BYTES + entries * ENTRY_BYTES,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
		});
		// picks submitted on the old one still copy out of it: destroy waits on them
		old?.destroy();
	}

	/** the four sides of target pixel (x, y up), in the floating-origin frame; #viewProj is frame's */
	#sides(x: number, y: number, frame: Frame): Float32Array {
		const ndc = (pixel: number, size: number) => (2 * pixel) / size - 1;
		const sides = [
			ndc(x - 0.5, frame.width),
			ndc(x + 0.5, frame.width),
			ndc(y - 0.5, frame.height),
			ndc(y + 0.5, frame.height)
		];
		planes(this.#planes, this.#viewProj, sides);
		return this.#planes.subarray(0, 16);
	}
}

/** for each of `probes` pixels, where its entries, blended front to back by view depth, first cover half of it */
function surfaces(
	floats: Float32Array,
	words: Uint32Array,
	count: number,
	probes: number,
	sources: readonly (PageSource | null)[]
): (Found | null)[] {
	const stride = ENTRY_BYTES / 4;
	const under: number[][] = Array.from({ length: probes }, () => []);
	for (let k = 0; k < count; k++) under[words[k * stride + 8]]?.push(k);
	return under.map((entries) => {
		entries.sort((a, b) => floats[a * stride + 3] - floats[b * stride + 3]);
		let through = 1;
		for (const k of entries) {
			const at = k * stride;
			through *= 1 - floats[at + 5];
			if (through <= 1 - SURFACE) {
				const source = sources[words[at + 10]];
				return {
					depth: floats[at + 4],
					layer: words[at + 6],
					object: words[at + 7],
					normal: [floats[at], floats[at + 1], floats[at + 2]],
					token: words[at + 9],
					row: source ? { ...source, row: words[at + 11] } : null
				};
			}
		}
		return null;
	});
}
