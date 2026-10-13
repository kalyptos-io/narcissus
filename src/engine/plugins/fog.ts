import type { Plugin } from '../plugin.ts';
import wgsl from './fog.wgsl?raw';

/** linear fog per splat by view depth, from start (share of the far clip) to the far clip */
export function fog(colour: readonly [number, number, number], start = 0.5): Plugin {
	return (host) =>
		host.shade({
			name: 'fog',
			uniforms: 2,
			wgsl,
			update(frame, out) {
				out.set(colour);
				out[3] = start * frame.far;
				out[4] = frame.far;
				out.fill(0, 5, 8);
			}
		});
}
