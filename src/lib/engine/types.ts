// data shared across engine modules; formats follow guldmund/docs/format.md

/** a pyramid unit: level and south-west corner in whole metres */
export interface UnitKey {
	level: number;
	e: number;
	n: number;
}

/** one page of a unit, as an .idx row or a .pack footer row */
export interface PageRow {
	g: number;
	i: number;
	j: number;
	count: number;
	/** first splat of quadrants 1, 2, 3 */
	quadrants: [number, number, number];
	/** extent box, unit-local ENU metres: min x, y, z then max x, y, z */
	box: Float32Array;
	offset: number;
	length: number;
}

export interface Idx extends UnitKey {
	/** 16 hex digits */
	pack: string;
	packSize: number;
	col: string | null;
	rows: PageRow[];
	/** quadrant a + 2b of this unit */
	children: { quadrant: number; idx: string }[];
	/** units two and three levels down, by column and row of this unit's grid at that depth */
	descendants: { depth: number; column: number; row: number; idx: string }[];
}

/** a unit's colour correction, dequantised */
export interface Col {
	n: number;
	pitch: number;
	margin: number;
	/** channel-major, 12 n n: node (i, j) of channel c at c n n + j n + i */
	values: Float32Array;
}

export interface WorldRoot extends UnitKey {
	/** relative to world.json */
	idx: string;
}

export interface World {
	version: 4;
	crs: string;
	height: string;
	leaf: number;
	roots: WorldRoot[];
	extent: { e: [number, number]; n: [number, number]; h: [number, number] };
	attribution: { retrieved: string; epoch: string };
}

/** a page decoded for the pool, colour corrected */
export interface DecodedPage {
	count: number;
	quadrants: [number, number, number];
	/** GEOMETRY_WORDS per splat, layout in format/spec.ts */
	geometry: Uint32Array;
	/** COLOUR_WORDS per splat */
	colour: Uint32Array;
	/** PAGE_PARAMS floats; origin is unit-local, the pool moves it into the floating-origin frame */
	params: Float32Array;
	/** per cluster of CLUSTER splats: min x, y, z, max x, y, z of their extents, relative to the origin */
	clusters: Float32Array;
}

/** a page to draw and its quadrant opacities, 0-255, quadrant k at bits 8k */
export interface Drawn {
	id: number;
	factors: number;
}

/** degrees; yaw clockwise from north, pitch negative looks down, fov vertical */
export interface Camera {
	e: number;
	n: number;
	h: number;
	yaw: number;
	pitch: number;
	fov: number;
}

export interface Settings {
	/** splats the engine may draw per frame */
	budget: number;
	/** metres; the far clip and the planner's reach */
	viewDistance: number;
}

export interface Stats {
	/** ms between the last frames, median */
	frameMs: number;
	/** main-thread ms per frame, median */
	cpuMs: number;
	/** gpu ms per frame, 0 without timestamps */
	gpuMs: number;
	/** gpu ms per pass */
	passes: Record<string, number>;
	/** splats drawn after culling, last measured frame */
	drawn: number;
	/** splats of the cut inside the frustum */
	planned: number;
	/** of planned, the splats not resident yet */
	missing: number;
	pages: { resident: number; drawn: number; loading: number; queued: number };
	/** bytes */
	memory: { pool: number; buffers: number };
	/** splats the pool holds at most */
	capacity: number;
	scale: number;
	loading: boolean;
}
