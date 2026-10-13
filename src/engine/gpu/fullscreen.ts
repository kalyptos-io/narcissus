import vs from './fullscreen.wgsl?raw';

/** a pass that runs code's fragment entry fs over every pixel of a target */
export class Fullscreen {
	#device: GPUDevice;
	#label: string;
	#pipeline: GPURenderPipeline;
	#resources: GPUBindingResource[] = [];
	#group: GPUBindGroup | undefined;

	constructor(device: GPUDevice, label: string, code: string, format: GPUTextureFormat) {
		const module = device.createShaderModule({ label, code: vs + code });
		this.#device = device;
		this.#label = label;
		this.#pipeline = device.createRenderPipeline({
			label,
			layout: 'auto',
			vertex: { module, entryPoint: 'vs' },
			fragment: { module, entryPoint: 'fs', targets: [{ format }] }
		});
	}

	/** resources bind at 0, 1, .. of group 0, which code declares; the group lasts while they stay the same */
	encode(
		encoder: GPUCommandEncoder,
		resources: GPUBindingResource[],
		target: GPUTextureView
	): void {
		if (!this.#group || resources.some((resource, k) => resource !== this.#resources[k])) {
			this.#resources = resources;
			this.#group = this.#device.createBindGroup({
				label: this.#label,
				layout: this.#pipeline.getBindGroupLayout(0),
				entries: resources.map((resource, binding) => ({ binding, resource }))
			});
		}
		const pass = encoder.beginRenderPass({
			label: this.#label,
			colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store' }]
		});
		pass.setPipeline(this.#pipeline);
		pass.setBindGroup(0, this.#group);
		pass.draw(3);
		pass.end();
	}
}
