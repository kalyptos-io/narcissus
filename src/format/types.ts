// the data of a tree as its parsers return it; layouts in docs/format.md

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
	/** TOP_PAGE for a root's top page */
	flags: number;
	count: number;
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
	version: 2;
	/** names of the horizontal system and the height datum; a reader does not interpret them */
	crs: string;
	height: string;
	leaf: number;
	roots: WorldRoot[];
	extent: { e: [number, number]; n: [number, number]; h: [number, number] };
	/** the members of world.json a reader does not know, as written */
	extra: Record<string, unknown>;
}

/** what a cut needs of a page's nodes; centres, radii and links are of its parents, in node order */
export interface PageNodes {
	/** per node, its family's count, 0 for none */
	counts: Uint8Array<ArrayBuffer>;
	/** 3 per parent, unit-local metres */
	centres: Float32Array<ArrayBuffer>;
	/** per parent, metres: the mean of its scales, grown with opacity past 1 */
	radii: Float32Array<ArrayBuffer>;
	/** per parent, as docs/format.md packs it */
	links: Uint32Array<ArrayBuffer>;
}

/** a page decoded for the pool, colour corrected */
export interface DecodedPage {
	count: number;
	/** GEOMETRY_WORDS per splat, layout in spec.ts */
	geometry: Uint32Array<ArrayBuffer>;
	/** COLOUR_WORDS per splat */
	colour: Uint32Array<ArrayBuffer>;
	/** PAGE_PARAMS floats; origin is unit-local, the pool moves it into the floating-origin frame */
	params: Float32Array<ArrayBuffer>;
	/** per cluster of CLUSTER splats: min x, y, z, max x, y, z of their extents, relative to the origin */
	clusters: Float32Array<ArrayBuffer>;
	nodes: PageNodes;
}
