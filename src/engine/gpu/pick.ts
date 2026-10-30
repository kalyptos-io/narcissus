// the surface under a pixel as the last frame showed it: where the splats it drew there, blended
// front to back, first reach half

import type { Frame, Shade } from '../plugin.ts';
import { planes } from '../math/frustum.ts';
import { multiply } from '../math/mat4.ts';
import { bufferGroup, bufferLayout, type FrameBuffers } from './buffers.ts';
import common from './common.wgsl?raw';
import masks from './masks.wgsl?raw';
import source from './pick.wgsl?raw';
import type { Pool } from './pool.ts';
import { shaded } from './project.ts';
import splat from './splat.wgsl?raw';

/** workgroups of a pick, pick.wgsl's PICK_GROUPS */
const GROUPS = 256;
/** bytes of pick.wgsl's Probe */
const PROBE_BYTES = 80;
/** bytes of pick.wgsl's Hits before its entries, and of each Entry */
const HEAD_BYTES = 16;
const ENTRY_BYTES = 32;
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
	/** the splat's thinnest axis, toward the camera */
	normal: [number, number, number];
}

export class Pick {
	#device: GPUDevice;
	#pool: Pool;
	#layout: GPUBindGroupLayout;
	#pipelineLayout: GPUPipelineLayout;
	#pipeline: GPUComputePipeline | undefined;
	#shades: { shade: Shade; slot: number }[] = [];
	#viewProj = new Float32Array(16);
	#planes = new Float32Array(24);
	#values = new Float32Array(PROBE_BYTES / 4);
	#probe: GPUBuffer;
	#resources: GPUBuffer[];
	#entries = 0;
	#hits!: GPUBuffer;
	#group!: GPUBindGroup;

	constructor(device: GPUDevice, pool: Pool, buffers: FrameBuffers) {
		this.#device = device;
		this.#pool = pool;
		this.#layout = bufferLayout(device, 'pick', GPUShaderStage.COMPUTE, [
			'uniform',
			'uniform',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'uniform',
			'storage'
		]);
		this.#pipelineLayout = device.createPipelineLayout({
			bindGroupLayouts: [this.#layout, pool.masks.layout]
		});
		// picks in flight share these: the queue runs each pick's writes after the last one's pass
		this.#probe = device.createBuffer({
			label: 'pick probe',
			size: PROBE_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		const { uniforms, plugins, work } = buffers;
		const resources = [uniforms, plugins, pool.geometry, pool.colour, pool.pages, pool.clusters];
		this.#resources = [...resources, work, this.#probe];
		this.#grow(ENTRIES);
	}

	/** the next pick runs these hooks, as project does */
	hooks(shades: { shade: Shade; slot: number }[]): void {
		this.#shades = shades;
		this.#pipeline = undefined;
	}

	/**
	 * submits a pick of target pixel (x, y from the top-left) over the frame's visible clusters;
	 * frame must be the last one submitted, whose uniforms and cull the buffers still hold. null
	 * where the splats over the pixel never reach half, and where more lay there than the buffer
	 * kept, which grows it for the next
	 */
	run(x: number, y: number, frame: Frame): Promise<Found | null> {
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
		const up = frame.height - y;
		values.set([x, up], 0);
		values.set(this.#sides(x, up, frame), 4);
		device.queue.writeBuffer(this.#probe, 0, values);
		device.queue.writeBuffer(this.#hits, 0, CLEAR);

		const encoder = device.createCommandEncoder({ label: 'pick' });
		const pass = encoder.beginComputePass({ label: 'pick' });
		pass.setBindGroup(0, this.#group);
		pass.setBindGroup(1, pool.masks.group);
		pass.setPipeline((this.#pipeline ??= this.#build()));
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
						return null;
					}
					return surface(
						new Float32Array(read, HEAD_BYTES),
						new Uint32Array(read, HEAD_BYTES),
						count
					);
				},
				() => null
			)
			.finally(() => readback.destroy());
	}

	destroy(): void {
		this.#probe.destroy();
		this.#hits.destroy();
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
		this.#group = bufferGroup(this.#device, 'pick', this.#layout, [...this.#resources, this.#hits]);
		// picks submitted on the old one still copy out of it: destroy waits on them
		old?.destroy();
	}

	/** the four sides of target pixel (x, y up), in the floating-origin frame */
	#sides(x: number, y: number, frame: Frame): Float32Array {
		const ndc = (pixel: number, size: number) => (2 * pixel) / size - 1;
		const m = multiply(this.#viewProj, frame.proj, frame.view);
		const sides = [
			ndc(x - 0.5, frame.width),
			ndc(x + 0.5, frame.width),
			ndc(y - 0.5, frame.height),
			ndc(y + 0.5, frame.height)
		];
		planes(this.#planes, m, sides);
		return this.#planes.subarray(0, 16);
	}

	#build(): GPUComputePipeline {
		const code = shaded([common, masks, splat, source], this.#shades);
		const module = this.#device.createShaderModule({ label: 'pick', code });
		return this.#device.createComputePipeline({
			label: 'pick',
			layout: this.#pipelineLayout,
			compute: { module, entryPoint: 'gather' }
		});
	}
}

/** where `count` entries, blended front to back by view depth, first cover half the pixel */
function surface(floats: Float32Array, words: Uint32Array, count: number): Found | null {
	const stride = ENTRY_BYTES / 4;
	const order = Array.from({ length: count }, (_, k) => k).sort(
		(a, b) => floats[a * stride + 3] - floats[b * stride + 3]
	);
	let through = 1;
	for (const k of order) {
		const at = k * stride;
		through *= 1 - floats[at + 5];
		if (through <= 1 - SURFACE)
			return {
				depth: floats[at + 4],
				layer: words[at + 6],
				normal: [floats[at], floats[at + 1], floats[at + 2]]
			};
	}
	return null;
}
