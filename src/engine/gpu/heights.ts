import { bufferGroup, bufferLayout } from './buffers.ts';
import common from './common.wgsl?raw';
import masks from './masks.wgsl?raw';
import source from './heights.wgsl?raw';
import { groups } from './layout.ts';
import type { Pool } from './pool.ts';

/** bytes of heights.wgsl's Area */
const AREA_BYTES = 32;
/** least opacity and largest scale in metres of a splat that counts as solid */
const OPACITY = 0.5;
const SCALE = 1;

/** z of the ordered bits heights.wgsl writes, NaN for an empty cell */
function unordered(keys: Uint32Array): Float32Array {
	const bits = new Uint32Array(keys.length);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		bits[i] = key === 0 ? 0x7fc00000 : key & 0x80000000 ? key & 0x7fffffff : ~key >>> 0;
	}
	return new Float32Array(bits.buffer);
}

/** the top of the pool's listed solid splats over a square window of 1 m cells */
export class Heights {
	#device: GPUDevice;
	#pool: Pool;
	#layout: GPUBindGroupLayout;
	#pipeline: GPUComputePipeline;

	constructor(device: GPUDevice, pool: Pool) {
		this.#device = device;
		this.#pool = pool;
		this.#layout = bufferLayout(device, 'heights', GPUShaderStage.COMPUTE, [
			'uniform',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'storage'
		]);
		const code = `${common}\n${masks}\n${source}`;
		const module = device.createShaderModule({ label: 'heights', code });
		this.#pipeline = device.createComputePipeline({
			label: 'heights',
			layout: device.createPipelineLayout({ bindGroupLayouts: [this.#layout, pool.masks.layout] }),
			compute: { module, entryPoint: 'heights' }
		});
	}

	/**
	 * encodes the window of cells x cells with south-west corner (x, y) in the floating-origin
	 * frame; the call it returns, once the encoder is submitted, gives each cell's top z in that
	 * frame, rows south to north, NaN where no splat counts
	 */
	encode(
		encoder: GPUCommandEncoder,
		x: number,
		y: number,
		cells: number,
		timestamps?: GPUComputePassTimestampWrites
	): () => Promise<Float32Array | null> {
		const device = this.#device;
		const pool = this.#pool;
		const { listed } = pool;
		const bytes = cells * cells * 4;
		const area = device.createBuffer({
			label: 'heights area',
			size: AREA_BYTES,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		const tops = device.createBuffer({
			label: 'heights',
			size: bytes,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
		});
		const readback = device.createBuffer({
			label: 'heights readback',
			size: bytes,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		const values = new ArrayBuffer(AREA_BYTES);
		new Float32Array(values).set([x, y, 0, 0, OPACITY, SCALE]);
		new Uint32Array(values).set([cells, listed], 2);
		device.queue.writeBuffer(area, 0, values);
		const resources = [area, pool.pages, pool.clusters, pool.list, pool.geometry, tops];
		const group = bufferGroup(device, 'heights', this.#layout, resources);
		const pass = encoder.beginComputePass({ label: 'heights', timestampWrites: timestamps });
		pass.setPipeline(this.#pipeline);
		pass.setBindGroup(0, group);
		pass.setBindGroup(1, pool.masks.group);
		if (listed > 0) pass.dispatchWorkgroups(...groups(listed));
		pass.end();
		encoder.copyBufferToBuffer(tops, 0, readback, 0, bytes);
		return () =>
			readback
				.mapAsync(GPUMapMode.READ)
				.then(
					() => unordered(new Uint32Array(readback.getMappedRange())),
					() => null
				)
				.finally(() => {
					area.destroy();
					tops.destroy();
					readback.destroy();
				});
	}
}
