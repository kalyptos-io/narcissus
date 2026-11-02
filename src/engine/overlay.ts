// host graphics: lines and markers in world coordinates, drawn over the splats

import type { Capsule } from './gpu/overlay.ts';
import { checkColour, checkPoint } from './check.ts';
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

/**
 * a change applies at the next frame; after remove() the setters do nothing and the getters keep
 * their last values
 */
export interface Line {
	points: readonly Point[];
	/** reads back with the defaults filled in */
	get style(): Required<LineStyle>;
	set style(style: LineStyle);
	visible: boolean;
	remove(): void;
}

/** a dot; as Line */
export interface Marker {
	point: Point;
	get style(): Required<MarkerStyle>;
	set style(style: MarkerStyle);
	visible: boolean;
	remove(): void;
}

const WHITE = [1, 1, 1, 1] as const;

/** a line as drawn, or a marker as a line of one point as wide as its size */
interface Shape extends Required<LineStyle> {
	points: readonly Point[];
	visible: boolean;
}

function finitePoints(points: readonly Point[]): readonly Point[] {
	if (!points.length) throw new RangeError('points must hold at least one point.');
	return points.map((p, k) => checkPoint(p, `points[${k}]`));
}

function positive(value: number, name: string): number {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${name} must be a finite number above 0.`);
	}
	return value;
}

function lineStyle(style: LineStyle): Required<LineStyle> {
	const { colour = WHITE, width = 2, closed = false, occlude = true } = style;
	return {
		colour: checkColour(colour, 'colour'),
		width: positive(width, 'width'),
		closed,
		occlude
	};
}

function markerStyle(style: MarkerStyle): Required<MarkerStyle> {
	const { colour = WHITE, size = 12, occlude = true } = style;
	return { colour: checkColour(colour, 'colour'), size: positive(size, 'size'), occlude };
}

/** a shape's capsules, radius in target pixels at ratio per css pixel */
function capsules(shape: Shape, ratio: number): Capsule[] {
	const { points, closed, width, colour, occlude } = shape;
	const ends = closed && points.length > 2 ? [...points, points[0]] : points;
	const pairs = ends.length > 1 ? ends.slice(1).map((b, k) => [ends[k], b]) : [[ends[0], ends[0]]];
	const radius = (width / 2) * ratio;
	return pairs.map(([a, b]) => ({ a, b, radius, colour, occlude }));
}

/** the lines and markers of an engine as the capsules the overlay draws */
export class Graphics {
	#shapes = new Set<Shape>();
	#reshaped = false;
	#changed: () => void;

	/** changed: the capsules changed and want a frame */
	constructor(changed: () => void) {
		this.#changed = changed;
	}

	line(points: readonly Point[], style: LineStyle = {}): Line {
		const shape: Shape = { points: finitePoints(points), ...lineStyle(style), visible: true };
		const set = this.#add(shape);
		return {
			get points() {
				return shape.points;
			},
			set points(points) {
				set({ points: finitePoints(points) });
			},
			get style() {
				const { colour, width, closed, occlude } = shape;
				return { colour, width, closed, occlude };
			},
			set style(style) {
				set(lineStyle(style));
			},
			get visible() {
				return shape.visible;
			},
			set visible(visible) {
				set({ visible });
			},
			remove: () => this.#remove(shape)
		};
	}

	marker(point: Point, style: MarkerStyle = {}): Marker {
		const { size, ...rest } = markerStyle(style);
		const shape: Shape = {
			points: [checkPoint(point, 'point')],
			...rest,
			width: size,
			closed: false,
			visible: true
		};
		const set = this.#add(shape);
		return {
			get point() {
				return shape.points[0];
			},
			set point(point) {
				set({ points: [checkPoint(point, 'point')] });
			},
			get style() {
				const { colour, width, occlude } = shape;
				return { colour, size: width, occlude };
			},
			set style(style) {
				const { size, ...rest } = markerStyle(style);
				set({ ...rest, width: size });
			},
			get visible() {
				return shape.visible;
			},
			set visible(visible) {
				set({ visible });
			},
			remove: () => this.#remove(shape)
		};
	}

	/** the next capsules() gives them though none changed: the target, origin or overlay did */
	reshape(): void {
		this.#reshaped = true;
	}

	/** the visible capsules, radius in target pixels at ratio per css pixel; null if none changed */
	capsules(ratio: number): Capsule[] | null {
		if (!this.#reshaped) return null;
		this.#reshaped = false;
		return [...this.#shapes].filter((s) => s.visible).flatMap((s) => capsules(s, ratio));
	}

	/** shape drawn from now on, and what sets its fields while it lasts */
	#add(shape: Shape): (fields: Partial<Shape>) => void {
		this.#shapes.add(shape);
		this.#change();
		return (fields) => {
			if (!this.#shapes.has(shape)) return;
			Object.assign(shape, fields);
			this.#change();
		};
	}

	#remove(shape: Shape): void {
		if (this.#shapes.delete(shape)) this.#change();
	}

	#change(): void {
		this.#reshaped = true;
		this.#changed();
	}
}
