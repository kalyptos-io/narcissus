import { Fullscreen } from '../gpu/fullscreen.ts';
import type { Plugin } from '../plugin.ts';
import code from './dof.wgsl?raw';

/** how far past the focus the blur grows to full, as a fraction of its distance */
const RANGE = 0.5;
/** blur radius at full strength, in pixels per 540 of target height */
const RADIUS = 3;

/** depth of field that blurs what lies past focus(), metres of view depth, at strength() of its full radius */
export function dof(focus: () => number, strength: () => number = () => 1): Plugin {
	return (host) =>
		host.post({
			name: 'dof',
			depth: true,
			setup(device, format) {
				const pass = new Fullscreen(device, 'dof', code, format);
				const uniforms = device.createBuffer({
					label: 'dof',
					size: 32,
					usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
				});
				const binding = { buffer: uniforms };
				const values = new Float32Array(8);
				return {
					run(encoder, frame, colour, depth, target) {
						const distance = focus();
						const { near, far, height } = frame;
						values.set([
							distance,
							distance * RANGE,
							near,
							Math.log(far / near),
							(RADIUS * height * strength()) / 540
						]);
						device.queue.writeBuffer(uniforms, 0, values);
						pass.encode(encoder, [colour, depth!, binding], target);
					},
					destroy() {
						uniforms.destroy();
					}
				};
			}
		});
}
