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
				return {
					run: (encoder, _frame, colour, _depth, target) => pass.encode(encoder, [colour], target),
					destroy() {}
				};
			}
		});
}
