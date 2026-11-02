// masks: vertical prisms that hide the splats of the world or of layers

import type { Pool } from './gpu/pool.ts';
import type { Layer } from './layer.ts';

/**
 * a splat of a target is hidden while its centre lies inside the polygon by the even-odd rule and
 * within z; at every level, through fades and while pages stream
 */
export interface MaskOptions {
	/** world e, n of its corners, three or more */
	polygon: readonly (readonly [number, number])[];
	/** world heights from and to; the full height when left out */
	z?: readonly [number, number];
	/** what it hides: 'world' for the world's own splats, and layers */
	targets: readonly (Layer | 'world')[];
}

export interface Mask {
	enabled: boolean;
	/** shows what it hid; the handle then does nothing */
	remove(): void;
}

/** the handle of a mask in pool, its options checked; changed runs as what the pool draws changes */
export function createMask(
	pool: Pool,
	{ polygon, z = [-Infinity, Infinity], targets }: MaskOptions,
	numberOf: (layer: Layer) => number | undefined,
	changed: () => void
): Mask {
	const layers = new Set(targets.map((t) => (t === 'world' ? 0 : (numberOf(t) ?? -1))));
	const prism = { polygon: Float64Array.from(polygon.flat()), z: [z[0], z[1]] as const };
	const id = pool.addMask(prism, layers);
	let enabled = true;
	let removed = false;
	changed();
	return {
		get enabled() {
			return enabled;
		},
		set enabled(on: boolean) {
			if (removed || on === enabled) return;
			enabled = on;
			pool.enableMask(id, on);
			changed();
		},
		remove() {
			if (removed) return;
			removed = true;
			pool.deleteMask(id);
			changed();
		}
	};
}
