// masks: vertical prisms that hide the splats of the world or of layers

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
