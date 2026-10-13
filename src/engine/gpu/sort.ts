import { groups, KEY_BITS, WORK } from './layout.ts';
import { bufferLayout, type FrameBuffers } from './buffers.ts';
import common from './common.wgsl?raw';
import code from './sort.wgsl?raw';

// mirror sort.wgsl
const BLOCK = 1024;
const CHUNK = 64;
const DIGITS = 256;
const PASSES = KEY_BITS / 8;
// uniform binding offsets must be multiples of 256 bytes
const PARAMS_STRIDE = 256;
const PARAMS_BYTES = 32;

/** keys and values of the WORK.projected splats in ascending key order; writes WORK.drawArgs */
export class Sort {
	/** byte offsets into buffers.sort of the sorted keys and values */
	readonly keys: number;
	readonly values: number;
	/** scratch bytes */
	readonly bytes: number;
	#owned: GPUBuffer[];
	#prepare: GPUComputePipeline;
	#kernels: GPUComputePipeline[];
	#prepareGroup: GPUBindGroup;
	#groups: GPUBindGroup[];
	/** workgroups over every block of a full buffer, and over its chunks */
	#blocks: [number, number];
	#chunks: number;

	constructor(device: GPUDevice, buffers: FrameBuffers) {
		const { capacity } = buffers;
		// passes ping-pong between the halves, so an odd count ends in keys' and values'
		this.keys = capacity * 8;
		this.values = capacity * 12;

		const blocks = Math.max(1, Math.ceil(capacity / BLOCK));
		// fixed sizes: chrome validates indirect args on its gpu process's main thread, a cost every
		// dispatch; kernels skip the blocks and chunks past the count
		this.#blocks = groups(blocks);
		this.#chunks = Math.ceil(blocks / CHUNK);
		const make = (label: string, size: number, usage: number) =>
			device.createBuffer({ label, size, usage });
		const storage = GPUBufferUsage.STORAGE;
		const params = make(
			'sort params',
			PASSES * PARAMS_STRIDE,
			GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		);
		const hist = make('sort histograms', blocks * DIGITS * 4, storage);
		const sums = make('sort chunk sums', this.#chunks * DIGITS * 4, storage);
		const state = make('sort state', 12, storage);
		this.#owned = [params, hist, sums, state];
		this.bytes = this.#owned.reduce((sum, b) => sum + b.size, 0);

		const words = new Uint32Array((PASSES * PARAMS_STRIDE) / 4);
		for (let p = 0; p < PASSES; p++) {
			const [src, dst] = p % 2 ? [2 * capacity, 0] : [0, 2 * capacity];
			words.set(
				[8 * p, src, dst, capacity, WORK.projected, WORK.drawArgs],
				(p * PARAMS_STRIDE) / 4
			);
		}
		device.queue.writeBuffer(params, 0, words);

		const entry = (binding: number, type: GPUBufferBindingType): GPUBindGroupLayoutEntry => ({
			binding,
			visibility: GPUShaderStage.COMPUTE,
			buffer: { type }
		});
		const main = bufferLayout(device, 'sort', GPUShaderStage.COMPUTE, [
			'uniform',
			'storage',
			'storage',
			'storage',
			'read-only-storage'
		]);
		const prepare = device.createBindGroupLayout({
			label: 'sort prepare',
			entries: [entry(0, 'uniform'), entry(5, 'storage'), entry(6, 'storage')]
		});
		const module = device.createShaderModule({ label: 'sort', code: common + code });
		const pipeline = (entryPoint: string, layout: GPUBindGroupLayout) =>
			device.createComputePipeline({
				label: `sort ${entryPoint}`,
				layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
				compute: { module, entryPoint }
			});
		this.#prepare = pipeline('prepare', prepare);
		this.#kernels = ['histogram', 'reduce', 'top', 'down', 'scatter'].map((name) =>
			pipeline(name, main)
		);

		const uniform = (p: number): GPUBufferBinding => ({
			buffer: params,
			offset: p * PARAMS_STRIDE,
			size: PARAMS_BYTES
		});
		this.#prepareGroup = device.createBindGroup({
			label: 'sort prepare',
			layout: prepare,
			entries: [
				{ binding: 0, resource: uniform(0) },
				{ binding: 5, resource: { buffer: state } },
				{ binding: 6, resource: { buffer: buffers.work } }
			]
		});
		this.#groups = Array.from({ length: PASSES }, (_, p) =>
			device.createBindGroup({
				label: `sort pass ${p}`,
				layout: main,
				entries: [
					{ binding: 0, resource: uniform(p) },
					{ binding: 1, resource: { buffer: buffers.sort } },
					{ binding: 2, resource: { buffer: hist } },
					{ binding: 3, resource: { buffer: sums } },
					{ binding: 4, resource: { buffer: state } }
				]
			})
		);
	}

	encode(encoder: GPUCommandEncoder, timestamps?: GPUComputePassTimestampWrites): void {
		const [histogram, reduce, top, down, scatter] = this.#kernels;
		const blocks = this.#blocks;
		const pass = encoder.beginComputePass({ label: 'sort', timestampWrites: timestamps });
		pass.setPipeline(this.#prepare);
		pass.setBindGroup(0, this.#prepareGroup);
		pass.dispatchWorkgroups(1);
		for (const group of this.#groups) {
			pass.setBindGroup(0, group);
			pass.setPipeline(histogram);
			pass.dispatchWorkgroups(...blocks);
			pass.setPipeline(reduce);
			pass.dispatchWorkgroups(this.#chunks);
			pass.setPipeline(top);
			pass.dispatchWorkgroups(1);
			pass.setPipeline(down);
			pass.dispatchWorkgroups(this.#chunks);
			pass.setPipeline(scatter);
			pass.dispatchWorkgroups(...blocks);
		}
		pass.end();
	}

	destroy(): void {
		for (const buffer of this.#owned) buffer.destroy();
	}
}
