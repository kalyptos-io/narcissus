import { WORK } from './layout.ts';
import { bufferGroup, type FrameBuffers } from './buffers.ts';
import source from './raster.wgsl?raw';
import type { Pool } from './pool.ts';
import { HOOKED, shaded, type Hooked } from './project.ts';
import type { Sort } from './sort.ts';

/** cleared to the sky, so blending leaves the finished image and needs no alpha; half rgba16float's bandwidth */
export const COLOUR_FORMAT: GPUTextureFormat = 'rgb10a2unorm';
/** the nearest drawn splat's log depth; a second colour target would double the blend work */
export const DEPTH_FORMAT: GPUTextureFormat = 'depth16unorm';

const OVER: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' };

/** sorted splats as instanced quads, premultiplied, back to front, the sampled through their hooks */
export class Raster {
	#device: GPUDevice;
	#pool: Pool;
	#format: GPUTextureFormat;
	#work: GPUBuffer;
	#sorted: GPUBuffer;
	/** samples over the coverage estimate, copied into the work buffer after the pass */
	#over: GPUBuffer;
	#layout: GPUBindGroupLayout;
	#pipelineLayout: GPUPipelineLayout;
	#hooks: readonly Hooked[] = [];
	#colour: GPURenderPipeline | undefined;
	#depth: GPURenderPipeline | undefined;
	#resources: GPUBuffer[];
	#group: GPUBindGroup | undefined;
	#bound: GPUBuffer | undefined;

	/** format is the colour target's: COLOUR_FORMAT, a float one in tests */
	constructor(
		device: GPUDevice,
		buffers: FrameBuffers,
		sort: Sort,
		pool: Pool,
		format: GPUTextureFormat
	) {
		this.#device = device;
		this.#pool = pool;
		this.#format = format;
		this.#work = buffers.work;
		this.#sorted = device.createBuffer({
			label: 'raster sorted',
			size: 16,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
		});
		const words = new Uint32Array([sort.keys / 4, sort.values / 4, 0, 0]);
		device.queue.writeBuffer(this.#sorted, 0, words);
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
			[FRAGMENT, 'read-only-storage'],
			[FRAGMENT, 'storage']
		];
		this.#layout = device.createBindGroupLayout({
			label: 'raster',
			entries: stages.map(([visibility, type], binding) => ({
				binding,
				visibility,
				buffer: { type }
			}))
		});
		this.#pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [this.#layout] });
		const { uniforms, projected, plugins } = buffers;
		this.#resources = [uniforms, projected, buffers.sort, this.#sorted, plugins, pool.pages];
	}

	/** the next frame draws sampled splats through these hooks, as project numbers them */
	hooks(hooks: readonly Hooked[]): void {
		this.#hooks = hooks;
		this.#colour = this.#depth = undefined;
	}

	/** clears colour to the sky; depth, when given, gets the nearest splat's log-depth span from near to far, 1 where none drew */
	encode(
		encoder: GPUCommandEncoder,
		colour: GPUTextureView,
		depth: GPUTextureView | null,
		sky: readonly [number, number, number],
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
		const pipeline = depth
			? (this.#depth ??= this.#pipeline('Depth'))
			: (this.#colour ??= this.#pipeline('Colour'));
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, this.#bind());
		pass.drawIndirect(this.#work, WORK.drawArgs * 4);
		pass.end();
		encoder.copyBufferToBuffer(this.#over, 0, this.#work, WORK.rasterOver * 4, 4);
	}

	destroy(): void {
		this.#sorted.destroy();
		this.#over.destroy();
	}

	/** the group over the extension as it stands: a flush may have replaced its buffer */
	#bind(): GPUBindGroup {
		const buffer = this.#pool.extension.buffer;
		if (this.#bound !== buffer) {
			const resources = [...this.#resources, buffer, this.#over];
			this.#group = bufferGroup(this.#device, 'raster', this.#layout, resources);
			this.#bound = buffer;
		}
		return this.#group!;
	}

	#pipeline(variant: 'Colour' | 'Depth'): GPURenderPipeline {
		const device = this.#device;
		const code = shaded([...HOOKED, source], this.#hooks);
		const module = device.createShaderModule({ label: 'raster', code });
		const sampled = this.#hooks.some(({ shade }) => shade.sample) ? 'Sampled' : '';
		return device.createRenderPipeline({
			label: `raster ${variant}`,
			layout: this.#pipelineLayout,
			vertex: { module, entryPoint: `vs${sampled}${variant}` },
			fragment: {
				module,
				entryPoint: `fs${sampled}`,
				targets: [{ format: this.#format, blend: { color: OVER, alpha: OVER } }]
			},
			primitive: { topology: 'triangle-strip' },
			// drawn back to front, the last write is the nearest
			depthStencil:
				variant === 'Depth'
					? { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'always' }
					: undefined
		});
	}
}
