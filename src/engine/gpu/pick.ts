// the surface under a pixel: the nearest splat that draws it solid, against the last frame

import type { Frame, Shade } from '../plugin.ts';
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
	#buffers: FrameBuffers;
	#layout: GPUBindGroupLayout;
	#pipelineLayout: GPUPipelineLayout;
	#pipelines: { nearest: GPUComputePipeline; surface: GPUComputePipeline } | undefined;
	#shades: { shade: Shade; slot: number }[] = [];
	#viewProj = new Float32Array(16);

	constructor(device: GPUDevice, pool: Pool, buffers: FrameBuffers) {
		this.#device = device;
		this.#pool = pool;
		this.#buffers = buffers;
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
		const probe = device.createBuffer({
			label: 'pick probe',
			size: PROBE_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		const hit = device.createBuffer({
			label: 'pick',
			size: HIT_WORDS * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
		});
		const readback = device.createBuffer({
			label: 'pick readback',
			size: HIT_WORDS * 4,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		const values = new Float32Array(PROBE_BYTES / 4);
		const up = frame.height - y;
		values.set([x, up], 0);
		values.set(this.#planes(x, up, frame), 4);
		device.queue.writeBuffer(probe, 0, values);
		device.queue.writeBuffer(hit, 0, new Uint32Array([NONE, 0, 0, 0, 0]));

		const { uniforms, plugins, work } = this.#buffers;
		const resources = [uniforms, plugins, pool.geometry, pool.colour, pool.pages, pool.clusters];
		const group = bufferGroup(device, 'pick', this.#layout, [...resources, work, probe, hit]);
		const pipelines = (this.#pipelines ??= this.#build());
		const encoder = device.createCommandEncoder({ label: 'pick' });
		const pass = encoder.beginComputePass({ label: 'pick' });
		pass.setBindGroup(0, group);
		pass.setBindGroup(1, pool.masks.group);
		pass.setPipeline(pipelines.nearest);
		pass.dispatchWorkgroups(GROUPS);
		pass.setPipeline(pipelines.surface);
		pass.dispatchWorkgroups(GROUPS);
		pass.end();
		encoder.copyBufferToBuffer(hit, 0, readback, 0, HIT_WORDS * 4);
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
			.finally(() => {
				probe.destroy();
				hit.destroy();
				readback.destroy();
			});
	}

	/** the four sides of target pixel (x, y up), in the floating-origin frame */
	#planes(x: number, y: number, frame: Frame): Float32Array {
		const m = multiply(this.#viewProj, frame.proj, frame.view);
		const out = new Float32Array(16);
		const ndc = (pixel: number, size: number) => (2 * pixel) / size - 1;
		const sides: [number, number, number][] = [
			[0, ndc(x - 0.5, frame.width), 1],
			[0, ndc(x + 0.5, frame.width), -1],
			[1, ndc(y - 0.5, frame.height), 1],
			[1, ndc(y + 0.5, frame.height), -1]
		];
		// clip r over clip w past the bound, on the side sign faces
		sides.forEach(([r, bound, sign], p) => {
			for (let k = 0; k < 4; k++) out[p * 4 + k] = sign * (m[k * 4 + r] - bound * m[k * 4 + 3]);
		});
		return out;
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
