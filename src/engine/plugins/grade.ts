import { Fullscreen } from '../gpu/fullscreen.ts';
import type { Plugin } from '../plugin.ts';
import code from './grade.wgsl?raw';

/** the clarity grade as a post pass */
export function grade(): Plugin {
	return (host) =>
		host.post({
			name: 'grade',
			setup(device, format) {
				const pass = new Fullscreen(device, 'grade', code, format);
				let source: GPUTextureView | undefined;
				let group: GPUBindGroup | undefined;
				return {
					run(encoder, _frame, colour, _depth, target) {
						if (colour !== source || !group) {
							source = colour;
							group = device.createBindGroup({
								label: 'grade',
								layout: pass.layout,
								entries: [{ binding: 0, resource: colour }]
							});
						}
						pass.encode(encoder, group, target);
					},
					destroy() {}
				};
			}
		});
}
