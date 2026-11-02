// host graphics: lines and markers in world coordinates, drawn over the splats

import type { Capsule } from './gpu/overlay.ts';
import type { Colour, Point } from './types.ts';

export interface LineStyle {
	colour?: Colour;
	/** css pixels */
	width?: number;
	/** joins the last point to the first */
	closed?: boolean;
	/** hidden where splats lie in front; true when left out */
	occlude?: boolean;
}

export interface MarkerStyle {
	colour?: Colour;
	/** css pixels across */
	size?: number;
	/** hidden where splats lie in front; true when left out */
	occlude?: boolean;
}

export interface Line {
	set(points: readonly Point[]): void;
	remove(): void;
}

export interface Marker {
	set(point: Point): void;
	remove(): void;
}

const WHITE = [1, 1, 1, 1] as const;

/** points as given; throws on none, or on one that is not three finite numbers */
function finite(points: readonly Point[]): readonly Point[] {
	if (!points.length || !points.every((p) => p.length === 3 && p.every(Number.isFinite))) {
		throw new Error('Give at least one point, each three finite numbers.');
	}
	return points;
}

/** the lines and markers of an engine as the capsules the overlay draws */
export class Graphics {
	/** by id, radius in css pixels */
	#capsules = new Map<number, Capsule[]>();
	#count = 0;
	#reshaped = false;
	#changed: () => void;

	/** changed: the capsules changed and want a frame */
	constructor(changed: () => void) {
		this.#changed = changed;
	}

	line(points: readonly Point[], style: LineStyle = {}): Line {
		const { colour = WHITE, width = 2, closed = false, occlude = true } = style;
		const capsules = (points: readonly Point[]) => {
			finite(points);
			const ends = closed && points.length > 2 ? [...points, points[0]] : points;
			const pairs =
				ends.length > 1 ? ends.slice(1).map((b, k) => [ends[k], b]) : [[ends[0], ends[0]]];
			return pairs.map(([a, b]) => ({ a, b, radius: width / 2, colour, occlude }));
		};
		const id = ++this.#count;
		this.#capsules.set(id, capsules(points));
		this.#change();
		return {
			set: (points) => {
				const next = capsules(points);
				if (!this.#capsules.has(id)) return;
				this.#capsules.set(id, next);
				this.#change();
			},
			remove: () => {
				if (this.#capsules.delete(id)) this.#change();
			}
		};
	}

	marker(point: Point, style: MarkerStyle = {}): Marker {
		const { size = 12, ...rest } = style;
		const line = this.line([point], { ...rest, width: size });
		return { set: (point) => line.set([point]), remove: line.remove };
	}

	/** the next capsules() gives them though none changed: the target, origin or overlay did */
	reshape(): void {
		this.#reshaped = true;
	}

	/** every capsule, radius in target pixels at ratio per css pixel; null when none changed since */
	capsules(ratio: number): Capsule[] | null {
		if (!this.#reshaped) return null;
		this.#reshaped = false;
		return [...this.#capsules.values()].flat().map((c) => ({ ...c, radius: c.radius * ratio }));
	}

	#change(): void {
		this.#reshaped = true;
		this.#changed();
	}
}
