// host graphics: lines and markers in world coordinates, drawn over the splats

/** rgba, each 0 to 1 */
export type Colour = readonly [number, number, number, number];
type Point = readonly [number, number, number];

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
