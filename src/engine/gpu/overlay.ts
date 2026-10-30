// host graphics drawn over the finished frame, tested against the splats' depth

import common from './common.wgsl?raw';
import code from './overlay.wgsl?raw';

/** a capsule from a to b, world coordinates; a marker where a is b */
export interface Capsule {
	a: readonly [number, number, number];
	b: readonly [number, number, number];
	/** pixels */
	radius: number;
	/** rgba 0 to 1 */
	colour: readonly [number, number, number, number];
	/** hidden where splats lie in front */
	occlude: boolean;
}

/** bytes of an instance: a, b, radius, colour, occlude */
const STRIDE = 36;
const OVER: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' };

export class Overlay {
	#device: GPUDevice;
	#uniforms: GPUBuffer;
	#pipeline: GPURenderPipeline;
	#instances: GPUBuffer | null = null;
	#count = 0;

	constructor(device: GPUDevice, format: GPUTextureFormat, uniforms: GPUBuffer) {
		this.#device = device;
		this.#uniforms = uniforms;
		const module = device.createShaderModule({ label: 'overlay', code: common + code });
		const attributes: GPUVertexAttribute[] = [
			{ shaderLocation: 0, offset: 0, format: 'float32x3' },
			{ shaderLocation: 1, offset: 12, format: 'float32x3' },
			{ shaderLocation: 2, offset: 24, format: 'float32' },
			{ shaderLocation: 3, offset: 28, format: 'unorm8x4' },
			{ shaderLocation: 4, offset: 32, format: 'uint32' }
		];
		this.#pipeline = device.createRenderPipeline({
			label: 'overlay',
			layout: 'auto',
			vertex: {
				module,
				entryPoint: 'vs',
				buffers: [{ arrayStride: STRIDE, stepMode: 'instance', attributes }]
			},
			fragment: {
				module,
				entryPoint: 'fs',
				targets: [{ format, blend: { color: OVER, alpha: OVER } }]
			},
			primitive: { topology: 'triangle-strip' }
		});
	}

	get count(): number {
		return this.#count;
	}

	/** the capsules to draw, moved into the floating-origin frame at origin */
	set(capsules: readonly Capsule[], origin: readonly [number, number, number]): void {
		this.#count = capsules.length;
		if (!capsules.length) return;
		const bytes = new ArrayBuffer(capsules.length * STRIDE);
		const floats = new Float32Array(bytes);
		const words = new Uint32Array(bytes);
		const colours = new Uint8Array(bytes);
		capsules.forEach(({ a, b, radius, colour, occlude }, k) => {
			const w = (k * STRIDE) / 4;
			for (let i = 0; i < 3; i++) {
				floats[w + i] = a[i] - origin[i];
				floats[w + 3 + i] = b[i] - origin[i];
			}
			floats[w + 6] = radius;
			colour.forEach(
				(c, i) => (colours[(w + 7) * 4 + i] = Math.round(Math.min(1, Math.max(0, c)) * 255))
			);
			words[w + 8] = occlude ? 1 : 0;
		});
		if (!this.#instances || this.#instances.size < bytes.byteLength) {
			this.#instances?.destroy();
			this.#instances = this.#device.createBuffer({
				label: 'overlay',
				size: 2 ** Math.ceil(Math.log2(bytes.byteLength)),
				usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
			});
		}
		this.#device.queue.writeBuffer(this.#instances, 0, bytes);
	}

	/** draws over target, which holds the finished frame; depth is the splats' log-depth span */
	encode(encoder: GPUCommandEncoder, target: GPUTextureView, depth: GPUTextureView): void {
		if (!this.#count) return;
		const group = this.#device.createBindGroup({
			label: 'overlay',
			layout: this.#pipeline.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: this.#uniforms } },
				{ binding: 1, resource: depth }
			]
		});
		const pass = encoder.beginRenderPass({
			label: 'overlay',
			colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }]
		});
		pass.setPipeline(this.#pipeline);
		pass.setBindGroup(0, group);
		pass.setVertexBuffer(0, this.#instances!);
		pass.draw(4, this.#count);
		pass.end();
	}

	destroy(): void {
		this.#instances?.destroy();
	}
}
