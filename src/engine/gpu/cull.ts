import { bufferLayout, liveGroup, type FrameBuffers } from './buffers.ts';
import clip from './clip.wgsl?raw';
import common from './common.wgsl?raw';
import source from './cull.wgsl?raw';
import type { Pool } from './pool.ts';

/** threads per cull workgroup, as in cull.wgsl */
const GROUP = 64;

/** the pool's drawn clusters against the frustum, the clips and zero quadrants, into the work list */
export class Cull {
	#pool: Pool;
	#cull: GPUComputePipeline;
	#group: () => GPUBindGroup;

	constructor(device: GPUDevice, pool: Pool, buffers: FrameBuffers) {
		this.#pool = pool;
		const layout = bufferLayout(device, 'cull', GPUShaderStage.COMPUTE, [
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
			layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
			compute: { module, entryPoint: 'cull' }
		});
		this.#group = liveGroup(device, 'cull', layout, () => [
			buffers.uniforms,
			pool.pages,
			pool.clusters,
			pool.list,
			buffers.work,
			pool.extension.buffer
		]);
	}

	encode(encoder: GPUCommandEncoder, timestamps?: GPUComputePassTimestampWrites): void {
		const pass = encoder.beginComputePass({ label: 'cull', timestampWrites: timestamps });
		pass.setBindGroup(0, this.#group());
		pass.setPipeline(this.#cull);
		if (this.#pool.listed) pass.dispatchWorkgroups(Math.ceil(this.#pool.listed / GROUP));
		pass.end();
	}
}
