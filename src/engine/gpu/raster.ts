import { WORK } from './layout.ts';
import { bufferGroup, bufferLayout, type FrameBuffers } from './buffers.ts';
import common from './common.wgsl?raw';
import code from './raster.wgsl?raw';
import type { Sort } from './sort.ts';

/** cleared to the sky, so blending leaves the finished image and needs no alpha; half rgba16float's bandwidth */
export const COLOUR_FORMAT: GPUTextureFormat = 'rgb10a2unorm';
/** the nearest drawn splat's log depth; a second colour target would double the blend work */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth16unorm';

const OVER: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' };

/** sorted splats as instanced quads, premultiplied, back to front */
export class Raster {
	#work: GPUBuffer;
	#sorted: GPUBuffer;
	#colour: GPURenderPipeline;
	#depth: GPURenderPipeline;
	#group: GPUBindGroup;

	constructor(device: GPUDevice, buffers: FrameBuffers, sort: Sort) {
		this.#work = buffers.work;
		this.#sorted = device.createBuffer({
			label: 'raster sorted',
			size: 16,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		const words = new Uint32Array([sort.keys / 4, sort.values / 4, 0, 0]);
		device.queue.writeBuffer(this.#sorted, 0, words);

		const layout = bufferLayout(device, 'raster', GPUShaderStage.VERTEX, [
			'uniform',
			'read-only-storage',
			'read-only-storage',
			'uniform'
		]);
		this.#group = bufferGroup(device, 'raster', layout, [
			buffers.uniforms,
			buffers.projected,
			buffers.sort,
			this.#sorted
		]);

		const module = device.createShaderModule({ label: 'raster', code: common + code });
		const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
		const pipeline = (variant: 'Colour' | 'Depth', depthStencil?: GPUDepthStencilState) =>
			device.createRenderPipeline({
				label: `raster ${variant}`,
				layout: pipelineLayout,
				vertex: { module, entryPoint: `vs${variant}` },
				fragment: {
					module,
					entryPoint: 'fs',
					targets: [{ format: COLOUR_FORMAT, blend: { color: OVER, alpha: OVER } }]
				},
				primitive: { topology: 'triangle-strip' },
				depthStencil
			});
		this.#colour = pipeline('Colour');
		// drawn back to front, the last write is the nearest
		this.#depth = pipeline('Depth', {
			format: DEPTH_FORMAT,
			depthWriteEnabled: true,
			depthCompare: 'always'
		});
	}

	/** clears colour to the sky; depth, when given, gets the nearest splat's log-depth span from near to far, 1 where none drew */
	encode(
		encoder: GPUCommandEncoder,
		colour: GPUTextureView,
		depth: GPUTextureView | null,
		sky: readonly [number, number, number],
		timestamps?: GPURenderPassTimestampWrites
	): void {
		const pass = encoder.beginRenderPass({
			label: 'raster',
			colorAttachments: [
				{ view: colour, loadOp: 'clear', clearValue: [...sky, 1], storeOp: 'store' }
			],
			depthStencilAttachment: depth
				? { view: depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' }
				: undefined,
			timestampWrites: timestamps
		});
		pass.setPipeline(depth ? this.#depth : this.#colour);
		pass.setBindGroup(0, this.#group);
		pass.drawIndirect(this.#work, WORK.drawArgs * 4);
		pass.end();
	}

	destroy(): void {
		this.#sorted.destroy();
	}
}
