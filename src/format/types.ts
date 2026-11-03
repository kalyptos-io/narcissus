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
	/** 16 hex digits of the unit's .atr and its size in bytes; null and 0 for none */
	atr: string | null;
	atrSize: number;
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

export type Scalar = 'u8' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32' | 'f16' | 'f32';

/** a stream world.json declares */
export interface Attribute {
	type: Scalar | 'records';
	/** 1 to 4; 0 for records */
	components: number;
	/** one per component; empty for records */
	default: number[];
	rule: 'preserved' | 'aggregated' | 'unavailable';
}

/** one stream's values for one page in an .atr */
export interface AtrChunk {
	/** index into Atr.streams */
	stream: number;
	encoding: number;
	/** blob offset of the page in the pack */
	offset: number;
	rows: number;
	/** byte offset and length of the deflated chunk in the file */
	at: number;
	length: number;
}

/** the tables and trailer of an .atr */
export interface Atr {
	/** 16 hex digits of the pack the values describe */
	pack: string;
	streams: string[];
	/** by blob offset, then stream */
	chunks: AtrChunk[];
}

export interface World {
	version: 1;
	/** names of the horizontal system and the height datum; a reader does not interpret them */
	crs: string;
	height: string;
	leaf: number;
	roots: WorldRoot[];
	extent: { e: [number, number]; n: [number, number]; h: [number, number] };
	/** the streams .atr files may hold, by name; empty when world.json declares none */
	attributes: Record<string, Attribute>;
	/** the members of world.json a reader does not know, as written */
	extra: Record<string, unknown>;
}

/** a page decoded for the pool, colour corrected */
export interface DecodedPage {
	count: number;
	quadrants: [number, number, number];
	/** GEOMETRY_WORDS per splat, layout in spec.ts */
	geometry: Uint32Array<ArrayBuffer>;
	/** COLOUR_WORDS per splat */
	colour: Uint32Array<ArrayBuffer>;
	/** PAGE_PARAMS floats; origin is unit-local, the pool moves it into the floating-origin frame */
	params: Float32Array<ArrayBuffer>;
	/** per cluster of CLUSTER splats: min x, y, z, max x, y, z of their extents, relative to the origin */
	clusters: Float32Array<ArrayBuffer>;
	/** the streams the engine asked for that the page has a chunk of */
	attributes?: PageAttribute[];
}

/** one stream of a decoded page, as the gpu reads it; layout in spec.ts */
export interface PageAttribute {
	/** the engine's id of the stream */
	stream: number;
	descriptor: number;
	words: Uint32Array<ArrayBuffer>;
}
