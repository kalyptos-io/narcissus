import vs from './fullscreen.wgsl?raw';

/** a pass that runs code's fragment entry fs over every pixel of a target */
export class Fullscreen {
	/** of bind group 0, which code declares */
	readonly layout: GPUBindGroupLayout;
	#label: string;
	#pipeline: GPURenderPipeline;

	constructor(device: GPUDevice, label: string, code: string, format: GPUTextureFormat) {
		const module = device.createShaderModule({ label, code: vs + code });
		this.#label = label;
		this.#pipeline = device.createRenderPipeline({
			label,
			layout: 'auto',
			vertex: { module, entryPoint: 'vs' },
			fragment: { module, entryPoint: 'fs', targets: [{ format }] }
		});
		this.layout = this.#pipeline.getBindGroupLayout(0);
	}

	encode(encoder: GPUCommandEncoder, group: GPUBindGroup, target: GPUTextureView): void {
		const pass = encoder.beginRenderPass({
			label: this.#label,
			colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store' }]
		});
		pass.setPipeline(this.#pipeline);
		pass.setBindGroup(0, group);
		pass.draw(3);
		pass.end();
	}
}
