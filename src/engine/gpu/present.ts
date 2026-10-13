import { Fullscreen } from './fullscreen.ts';
import code from './present.wgsl?raw';

/** the colour target onto the canvas */
export const present = (device: GPUDevice, format: GPUTextureFormat) =>
	new Fullscreen(device, 'present', code, format);
