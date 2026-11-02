// masks: vertical prisms that hide, fade or tint the splats of the world or of layers

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
	/** what covered splats keep, 0 to 1; 0, the default, hides them */
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
	const { polygon, targets, z = [-Infinity, Infinity], outside = false } = options;
	const { opacity = 0, tint = [0, 0, 0, 0] } = options;
	const held = { polygon, targets, z, outside, opacity, tint };
	const spec: Spec = {
		prism: { edges: edgesOf(polygon), z: ordered(z), outside },
		targets: layers(targets, shown),
		opacity: fraction(opacity),
		tint: colour(tint)
	};
	const id = pool.addMask(spec);
	let enabled = true;
	let removed = false;
	changed();
	const update = () => {
		pool.setMask(id, spec);
		changed();
	};
	return {
		get polygon() {
			return held.polygon;
		},
		set polygon(polygon) {
			if (removed) return;
			spec.prism = { ...spec.prism, edges: edgesOf(polygon) };
			held.polygon = polygon;
			update();
		},
		get z() {
			return held.z;
		},
		set z(z) {
			if (removed) return;
			spec.prism = { ...spec.prism, z: ordered(z) };
			held.z = z;
			update();
		},
		get targets() {
			return held.targets;
		},
		set targets(targets) {
			if (removed) return;
			spec.targets = layers(targets, shown);
			held.targets = targets;
			update();
		},
		get outside() {
			return held.outside;
		},
		set outside(outside) {
			if (removed) return;
			spec.prism = { ...spec.prism, outside };
			held.outside = outside;
			update();
		},
		get opacity() {
			return held.opacity;
		},
		set opacity(opacity) {
			if (removed) return;
			held.opacity = spec.opacity = fraction(opacity);
			update();
		},
		get tint() {
			return held.tint;
		},
		set tint(tint) {
			if (removed) return;
			held.tint = spec.tint = colour(tint);
			update();
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

function fraction(opacity: number): number {
	if (!(opacity >= 0 && opacity <= 1)) {
		throw new RangeError('A mask opacity must be a number from 0 to 1.');
	}
	return opacity;
}

function colour(tint: Colour): Colour {
	if (!(tint.length === 4 && tint.every((v) => v >= 0 && v <= 1))) {
		throw new RangeError('A mask tint must be four numbers from 0 to 1.');
	}
	return tint;
}

/** pool layer numbers of targets, 0 for the world */
function layers(targets: readonly (Layer | 'world')[], shown: Layers): Set<number> {
	return new Set(
		targets.map((t) => {
			if (t === 'world') return 0;
			const number = shown.numberOf(t);
			// a removed layer keeps its number
			if (number === undefined || shown.layerOf(number) !== t) {
				throw new RangeError("A mask's targets must be 'world' or live layers of this engine.");
			}
			return number;
		})
	);
}
