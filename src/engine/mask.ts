// masks: vertical prisms that hide, fade or tint the splats of the world or of layers

import { checkColour, checkUnit } from './check.ts';
import type { Pool } from './gpu/pool.ts';
import type { Spec } from './gpu/masks.ts';
import type { Layer, Layers } from './layer.ts';
import { edges } from './math/prism.ts';
import type { Colour, Ring } from './types.ts';

/**
 * a splat of a target is covered while its centre lies inside the polygon and within z, or outside
 * that prism when outside is set; a covered splat keeps opacity of its own and takes the tint. at
 * every level, through fades and while pages stream
 */
export interface MaskOptions {
	/** one ring or several, by the even-odd rule: holes and islands; GeoJSON Polygon coordinates fit */
	polygon: Ring | readonly Ring[];
	/** world heights from and to; the full height when left out */
	z?: readonly [from: number, to: number];
	/** what it acts on: 'world' for the world's own splats, and layers */
	targets: readonly (Layer | 'world')[];
	/** acts on what lies outside the prism instead */
	outside?: boolean;
	/** what covered splats keep, 0 to 1; by default 1 with a tint, else 0, which hides them */
	opacity?: number;
	/** mixes their colour toward rgb by a; none by default */
	tint?: Colour;
}

/** its fields as MaskOptions; a change applies at the next frame */
export interface Mask {
	polygon: Ring | readonly Ring[];
	z: readonly [from: number, to: number];
	targets: readonly (Layer | 'world')[];
	outside: boolean;
	opacity: number;
	tint: Colour;
	enabled: boolean;
	/** shows what it covered; the handle then does nothing */
	remove(): void;
}

/**
 * the handle of a mask in pool over layers of shown, its options checked; changed runs as what the
 * pool draws changes
 */
export function createMask(
	pool: Pool,
	options: MaskOptions,
	shown: Layers,
	changed: () => void
): Mask {
	const { z = [-Infinity, Infinity], outside = false } = options;
	const { opacity = options.tint ? 1 : 0, tint = [0, 0, 0, 0] } = options;
	let { polygon, targets } = options;
	const spec: Spec = {
		prism: { edges: edgesOf(polygon), z: ordered(z), outside },
		targets: layers(targets, shown),
		opacity: checkUnit(opacity, 'A mask opacity'),
		tint: checkColour(tint, 'A mask tint')
	};
	const id = pool.addMask(spec);
	let enabled = true;
	let removed = false;
	changed();
	const edit = (apply: () => void) => {
		if (removed) return;
		apply();
		pool.setMask(id, spec);
		changed();
	};
	return {
		get polygon() {
			return polygon;
		},
		set polygon(value) {
			edit(() => {
				spec.prism = { ...spec.prism, edges: edgesOf(value) };
				polygon = value;
			});
		},
		get z() {
			return spec.prism.z;
		},
		set z(z) {
			edit(() => (spec.prism = { ...spec.prism, z: ordered(z) }));
		},
		get targets() {
			return targets;
		},
		set targets(value) {
			edit(() => {
				spec.targets = layers(value, shown);
				targets = value;
			});
		},
		get outside() {
			return spec.prism.outside;
		},
		set outside(outside) {
			edit(() => (spec.prism = { ...spec.prism, outside }));
		},
		get opacity() {
			return spec.opacity;
		},
		set opacity(opacity) {
			edit(() => (spec.opacity = checkUnit(opacity, 'A mask opacity')));
		},
		get tint() {
			return spec.tint;
		},
		set tint(tint) {
			edit(() => (spec.tint = checkColour(tint, 'A mask tint')));
		},
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

function edgesOf(polygon: Ring | readonly Ring[]): Float64Array {
	const rings =
		typeof polygon[0]?.[0] === 'number' ? [polygon as Ring] : (polygon as readonly Ring[]);
	const ok = (ring: Ring) =>
		ring.length >= 3 && ring.every((c) => Number.isFinite(c[0]) && Number.isFinite(c[1]));
	if (rings.length === 0 || !rings.every(ok)) {
		throw new RangeError('A mask polygon needs rings of three or more corners of finite e and n.');
	}
	return edges(rings);
}

function ordered(z: readonly [number, number]): readonly [number, number] {
	if (!(z.length === 2 && z[0] <= z[1])) {
		throw new RangeError('A mask z must be [from, to] with from at most to.');
	}
	return z;
}

/** pool layer numbers of targets, 0 for the world */
function layers(targets: readonly (Layer | 'world')[], shown: Layers): Set<number> {
	return new Set(
		targets.map((t) => {
			if (t === 'world') return 0;
			const number = shown.numberOf(t);
			if (number === undefined) {
				throw new RangeError("A mask's targets must be 'world' or live layers of this engine.");
			}
			return number;
		})
	);
}
