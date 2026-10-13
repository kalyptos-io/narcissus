import { Fullscreen } from './fullscreen.ts';
import code from './present.wgsl?raw';

/** the colour target onto the canvas */
export class Present {
	#device: GPUDevice;
	#pass: Fullscreen;
	#source: GPUTextureView | undefined;
	#group: GPUBindGroup | undefined;

	constructor(device: GPUDevice, format: GPUTextureFormat) {
		this.#device = device;
		this.#pass = new Fullscreen(device, 'present', code, format);
	}

	encode(encoder: GPUCommandEncoder, source: GPUTextureView, target: GPUTextureView): void {
		if (source !== this.#source || !this.#group) {
			this.#source = source;
			this.#group = this.#device.createBindGroup({
				label: 'present',
				layout: this.#pass.layout,
				entries: [{ binding: 0, resource: source }]
			});
		}
		this.#pass.encode(encoder, this.#group, target);
	}
}
