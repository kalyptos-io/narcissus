import { bufferGroup, bufferLayout, type FrameBuffers } from './buffers.ts';
import common from './common.wgsl?raw';
import source from './cull.wgsl?raw';
import type { Pool } from './pool.ts';

/** threads per cull workgroup, as in cull.wgsl */
const GROUP = 64;

/** the pool's drawn clusters against the frustum and zero quadrants, into the work list */
export class Cull {
	#pool: Pool;
	#cull: GPUComputePipeline;
	#group: GPUBindGroup;

	constructor(device: GPUDevice, pool: Pool, buffers: FrameBuffers) {
		this.#pool = pool;
		const layout = bufferLayout(device, 'cull', GPUShaderStage.COMPUTE, [
			'uniform',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'storage'
		]);
		const module = device.createShaderModule({ label: 'cull', code: `${common}\n${source}` });
		this.#cull = device.createComputePipeline({
			label: 'cull',
			layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
			compute: { module, entryPoint: 'cull' }
		});
		const resources = [buffers.uniforms, pool.pages, pool.clusters, pool.list, buffers.work];
		this.#group = bufferGroup(device, 'cull', layout, resources);
	}

	encode(encoder: GPUCommandEncoder, timestamps?: GPUComputePassTimestampWrites): void {
		const pass = encoder.beginComputePass({ label: 'cull', timestampWrites: timestamps });
		pass.setBindGroup(0, this.#group);
		pass.setPipeline(this.#cull);
		if (this.#pool.listed) pass.dispatchWorkgroups(Math.ceil(this.#pool.listed / GROUP));
		pass.end();
	}
}
