// data shared across engine modules

/** world metres: easting, northing, height */
export type Point = readonly [e: number, n: number, h: number];

/** world e, n corners of a ring; the last joins the first, whether it repeats it or not */
export type Ring = readonly (readonly [e: number, n: number])[];

/** rgba, each 0 to 1 */
export type Colour = readonly [r: number, g: number, b: number, a: number];

/** a page to draw and its quadrant opacities, 0-255, quadrant k at bits 8k */
export interface Drawn {
	id: number;
	factors: number;
}

/** world metres, min and max per axis, as World.extent */
export interface Box {
	e: readonly [number, number];
	n: readonly [number, number];
	h: readonly [number, number];
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
	/** the budget adapts within it to hold 30 fps, starting from budget; without it the budget stays */
	budgetRange?: readonly [number, number];
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
	/** bytes; extension holds attribute streams, plugin tables and sample records */
	memory: { pool: number; buffers: number; extension: number };
	/** splats the pool holds at most */
	capacity: number;
	/** splats a frame may draw now */
	budget: number;
	scale: number;
	loading: boolean;
}

/** how far the view has loaded, as stats() also gives it */
export type Progress = Pick<Stats, 'planned' | 'missing' | 'loading'>;
