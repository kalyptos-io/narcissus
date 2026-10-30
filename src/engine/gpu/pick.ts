// the surface under a pixel: the nearest splat that draws it solid, against the last frame

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
/** u32 words pick.wgsl writes: depth bits, layer, normal */
const HIT_WORDS = 5;
const NONE = 0xffffffff;
const CLEAR = new Uint32Array([NONE, 0, 0, 0, 0]);

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
	#pipelines: { nearest: GPUComputePipeline; surface: GPUComputePipeline } | undefined;
	#shades: { shade: Shade; slot: number }[] = [];
	#viewProj = new Float32Array(16);
	#planes = new Float32Array(24);
	#values = new Float32Array(PROBE_BYTES / 4);
	#probe: GPUBuffer;
	#hit: GPUBuffer;
	#group: GPUBindGroup;

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
		this.#hit = device.createBuffer({
			label: 'pick',
			size: HIT_WORDS * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
		});
		const { uniforms, plugins, work } = buffers;
		const resources = [uniforms, plugins, pool.geometry, pool.colour, pool.pages, pool.clusters];
		this.#group = bufferGroup(device, 'pick', this.#layout, [
			...resources,
			work,
			this.#probe,
			this.#hit
		]);
	}

	/** the next pick runs these hooks, as project does */
	hooks(shades: { shade: Shade; slot: number }[]): void {
		this.#shades = shades;
		this.#pipelines = undefined;
	}

	/**
	 * submits a pick of target pixel (x, y from the top-left) over the frame's visible clusters;
	 * frame must be the last one submitted, whose uniforms and cull the buffers still hold
	 */
	run(x: number, y: number, frame: Frame): Promise<Found | null> {
		const device = this.#device;
		const pool = this.#pool;
		const readback = device.createBuffer({
			label: 'pick readback',
			size: HIT_WORDS * 4,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		const values = this.#values;
		const up = frame.height - y;
		values.set([x, up], 0);
		values.set(this.#sides(x, up, frame), 4);
		device.queue.writeBuffer(this.#probe, 0, values);
		device.queue.writeBuffer(this.#hit, 0, CLEAR);

		const pipelines = (this.#pipelines ??= this.#build());
		const encoder = device.createCommandEncoder({ label: 'pick' });
		const pass = encoder.beginComputePass({ label: 'pick' });
		pass.setBindGroup(0, this.#group);
		pass.setBindGroup(1, pool.masks.group);
		pass.setPipeline(pipelines.nearest);
		pass.dispatchWorkgroups(GROUPS);
		pass.setPipeline(pipelines.surface);
		pass.dispatchWorkgroups(GROUPS);
		pass.end();
		encoder.copyBufferToBuffer(this.#hit, 0, readback, 0, HIT_WORDS * 4);
		device.queue.submit([encoder.finish()]);
		return readback
			.mapAsync(GPUMapMode.READ)
			.then(
				() => {
					const words = new Uint32Array(readback.getMappedRange());
					if (words[0] === NONE) return null;
					const floats = new Float32Array(words.buffer);
					const normal: Found['normal'] = [floats[2], floats[3], floats[4]];
					return { depth: floats[0], layer: words[1], normal };
				},
				() => null
			)
			.finally(() => readback.destroy());
	}

	destroy(): void {
		this.#probe.destroy();
		this.#hit.destroy();
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

	#build(): { nearest: GPUComputePipeline; surface: GPUComputePipeline } {
		const code = shaded([common, masks, splat, source], this.#shades);
		const module = this.#device.createShaderModule({ label: 'pick', code });
		const pipeline = (entryPoint: string) =>
			this.#device.createComputePipeline({
				label: `pick ${entryPoint}`,
				layout: this.#pipelineLayout,
				compute: { module, entryPoint }
			});
		return { nearest: pipeline('nearest'), surface: pipeline('surface') };
	}
}
