import { WORK } from './layout.ts';
import { liveGroup, type FrameBuffers } from './buffers.ts';
import source from './raster.wgsl?raw';
import type { Pool } from './pool.ts';
import { shaded, type Hooked } from './project.ts';
import type { Sort } from './sort.ts';

/** cleared to the sky, so blending leaves the finished image and needs no alpha; half rgba16float's bandwidth */
export const COLOUR_FORMAT: GPUTextureFormat = 'rgb10a2unorm';
/** the nearest drawn splat's log depth; a second colour target would double the blend work */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth16unorm';

/** premultiplied over */
export const OVER: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' };

/** sorted splats as instanced quads, premultiplied, back to front, the sampled through their hooks */
export class Raster {
	#device: GPUDevice;
	#format: GPUTextureFormat;
	#buffers: FrameBuffers;
	#sort: Sort;
	#sorted: GPUBuffer;
	/** samples over the coverage estimate, copied into the work buffer after the pass */
	#over: GPUBuffer;
	#pipelineLayout: GPUPipelineLayout;
	#code = shaded(source, [], 'sample');
	#module: GPUShaderModule | undefined;
	/** by their vertex entry point less vs */
	#pipelines = new Map<string, GPURenderPipeline>();
	#group: () => GPUBindGroup;

	/** format is the colour target's: COLOUR_FORMAT, a float one in tests */
	constructor(
		device: GPUDevice,
		buffers: FrameBuffers,
		sort: Sort,
		pool: Pool,
		format: GPUTextureFormat
	) {
		this.#device = device;
		this.#format = format;
		this.#buffers = buffers;
		this.#sort = sort;
		this.#sorted = device.createBuffer({
			label: 'raster sorted',
			size: 16,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		this.resize();
		this.#over = device.createBuffer({
			label: 'raster over',
			size: 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
		});

		// the vertex stage reads the sorted splats, the fragment stage the sample records
		const { VERTEX, FRAGMENT } = GPUShaderStage;
		const stages: [number, GPUBufferBindingType][] = [
			[VERTEX | FRAGMENT, 'uniform'],
			[VERTEX, 'read-only-storage'],
			[VERTEX, 'read-only-storage'],
			[VERTEX, 'uniform'],
			[FRAGMENT, 'uniform'],
			[FRAGMENT, 'read-only-storage'],
			[FRAGMENT, 'storage']
		];
		const layout = device.createBindGroupLayout({
			label: 'raster',
			entries: stages.map(([visibility, type], binding) => ({
				binding,
				visibility,
				buffer: { type }
			}))
		});
		this.#pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
		this.#group = liveGroup(device, 'raster', layout, () => [
			buffers.uniforms,
			buffers.projected,
			buffers.sort,
			this.#sorted,
			buffers.plugins,
			pool.extension.buffer,
			this.#over
		]);
	}

	/** reads the sorted splats where sort, resized, puts them */
	resize(): void {
		const words = new Uint32Array([this.#sort.keys / 4, this.#sort.values / 4, 0, 0]);
		this.#device.queue.writeBuffer(this.#sorted, 0, words);
	}

	/** the next frame draws sampled splats through these hooks, as project numbers them */
	hooks(hooks: readonly Hooked[]): void {
		const code = shaded(source, hooks, 'sample');
		if (code === this.#code) return;
		this.#code = code;
		this.#module = undefined;
		this.#pipelines.clear();
	}

	/**
	 * clears colour to the sky; depth, when given, gets the nearest splat's log-depth span from near
	 * to far, 1 where none drew; sampled where the frame holds records, which project may tag splats with
	 */
	encode(
		encoder: GPUCommandEncoder,
		colour: GPUTextureView,
		depth: GPUTextureView | null,
		sky: readonly [number, number, number],
		sampled: boolean,
		timestamps?: GPURenderPassTimestampWrites
	): void {
		encoder.clearBuffer(this.#over);
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
		const name = `${sampled ? 'Sampled' : ''}${depth ? 'Depth' : 'Colour'}`;
		let pipeline = this.#pipelines.get(name);
		if (!pipeline) this.#pipelines.set(name, (pipeline = this.#pipeline(name)));
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, this.#group());
		const { work } = this.#buffers;
		pass.drawIndirect(work, WORK.drawArgs * 4);
		pass.end();
		encoder.copyBufferToBuffer(this.#over, 0, work, WORK.rasterOver * 4, 4);
	}

	destroy(): void {
		this.#sorted.destroy();
		this.#over.destroy();
	}

	/** name is its vertex entry point less vs */
	#pipeline(name: string): GPURenderPipeline {
		const device = this.#device;
		const module = (this.#module ??= device.createShaderModule({
			label: 'raster',
			code: this.#code
		}));
		return device.createRenderPipeline({
			label: `raster ${name}`,
			layout: this.#pipelineLayout,
			vertex: { module, entryPoint: `vs${name}` },
			fragment: {
				module,
				entryPoint: name.startsWith('Sampled') ? 'fsSampled' : 'fs',
				targets: [{ format: this.#format, blend: { color: OVER, alpha: OVER } }]
			},
			primitive: { topology: 'triangle-strip' },
			// drawn back to front, the last write is the nearest
			depthStencil: name.endsWith('Depth')
				? { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'always' }
				: undefined
		});
	}
}
