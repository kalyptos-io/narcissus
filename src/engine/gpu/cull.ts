import { bufferGroup, bufferLayout, type FrameBuffers } from './buffers.ts';
import clip from './clip.wgsl?raw';
import common from './common.wgsl?raw';
import source from './cull.wgsl?raw';
import type { Pool } from './pool.ts';

/** threads per cull workgroup, as in cull.wgsl */
const GROUP = 64;

/** the pool's drawn clusters against the frustum, the clips and zero quadrants, into the work list */
export class Cull {
	#device: GPUDevice;
	#pool: Pool;
	#layout: GPUBindGroupLayout;
	#cull: GPUComputePipeline;
	#resources: GPUBuffer[];
	#group: GPUBindGroup | undefined;
	#bound: GPUBuffer | undefined;

	constructor(device: GPUDevice, pool: Pool, buffers: FrameBuffers) {
		this.#device = device;
		this.#pool = pool;
		this.#layout = bufferLayout(device, 'cull', GPUShaderStage.COMPUTE, [
			'uniform',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'storage',
			'read-only-storage'
		]);
		const code = `${common}\n${clip}\n${source}`;
		const module = device.createShaderModule({ label: 'cull', code });
		this.#cull = device.createComputePipeline({
			label: 'cull',
			layout: device.createPipelineLayout({ bindGroupLayouts: [this.#layout] }),
			compute: { module, entryPoint: 'cull' }
		});
		this.#resources = [buffers.uniforms, pool.pages, pool.clusters, pool.list, buffers.work];
	}

	encode(encoder: GPUCommandEncoder, timestamps?: GPUComputePassTimestampWrites): void {
		const pass = encoder.beginComputePass({ label: 'cull', timestampWrites: timestamps });
		pass.setBindGroup(0, this.#bind());
		pass.setPipeline(this.#cull);
		if (this.#pool.listed) pass.dispatchWorkgroups(Math.ceil(this.#pool.listed / GROUP));
		pass.end();
	}

	/** the group over the extension as it stands: a flush may have replaced its buffer */
	#bind(): GPUBindGroup {
		const buffer = this.#pool.extension.buffer;
		if (this.#bound !== buffer) {
			const resources = [...this.#resources, buffer];
			this.#group = bufferGroup(this.#device, 'cull', this.#layout, resources);
			this.#bound = buffer;
		}
		return this.#group!;
	}
}
