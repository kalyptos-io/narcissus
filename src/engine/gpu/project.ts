import type { Shade } from '../plugin.ts';
import { bufferGroup, bufferLayout, type FrameBuffers } from './buffers.ts';
import common from './common.wgsl?raw';
import { WORK } from './layout.ts';
import source from './project.wgsl?raw';
import type { Pool } from './pool.ts';

export class Project {
	#device: GPUDevice;
	#layout: GPUPipelineLayout;
	#pipeline: GPUComputePipeline | undefined;
	#shades: { shade: Shade; slot: number }[] = [];
	#group: GPUBindGroup;
	#pool: Pool;
	#work: GPUBuffer;
	#visible: GPUBuffer;

	constructor(device: GPUDevice, pool: Pool, buffers: FrameBuffers) {
		this.#device = device;
		this.#pool = pool;
		this.#work = buffers.work;
		this.#visible = buffers.visible;
		const layout = bufferLayout(device, 'project', GPUShaderStage.COMPUTE, [
			'uniform',
			'uniform',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'storage',
			'storage',
			'storage',
			'uniform'
		]);
		this.#layout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
		const resources = [
			buffers.uniforms,
			buffers.plugins,
			pool.geometry,
			pool.colour,
			pool.pages,
			pool.clusters,
			buffers.work,
			buffers.projected,
			buffers.sort,
			buffers.visible
		];
		this.#group = bufferGroup(device, 'project', layout, resources);
	}

	/** the next frame's pipeline runs these hooks in order, each reading from its first slot */
	hooks(shades: { shade: Shade; slot: number }[]): void {
		this.#shades = shades;
		this.#pipeline = undefined;
	}

	encode(encoder: GPUCommandEncoder, timestamps?: GPUComputePassTimestampWrites): void {
		// a uniform count keeps the loop uniform across each workgroup
		encoder.copyBufferToBuffer(this.#work, WORK.visible * 4, this.#visible, 0, 4);
		const count = Math.max(1, Math.min(256, this.#pool.listed));
		const pass = encoder.beginComputePass({ label: 'project', timestampWrites: timestamps });
		pass.setPipeline((this.#pipeline ??= this.#build()));
		pass.setBindGroup(0, this.#group);
		// chrome validates indirect args on its gpu process's main thread, a cost every frame
		pass.dispatchWorkgroups(count);
		pass.end();
	}

	#build(): GPUComputePipeline {
		const shades = this.#shades;
		const calls = shades.map(({ shade, slot }) => {
			const slots = Array.from({ length: shade.uniforms }, (_, k) => `plugins[${slot + k}]`);
			return `\t${shade.name}(s, array<vec4f, ${shade.uniforms}>(${slots.join(', ')}));`;
		});
		const code = [
			common,
			source,
			...shades.map(({ shade }) => shade.wgsl),
			'fn shade(s: ptr<function, Splat>) {',
			...calls,
			'}'
		].join('\n');
		const module = this.#device.createShaderModule({ label: 'project', code });
		return this.#device.createComputePipeline({
			label: 'project',
			layout: this.#layout,
			compute: { module, entryPoint: 'project' }
		});
	}
}
