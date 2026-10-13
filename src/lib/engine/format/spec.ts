// format v1 constants (guldmund/docs/format.md) and the engine's gpu layouts built on them

export const C0 = 0.28209479177387814;
export const C1 = 0.4886025119029199;

/** metres; a page at level g has side PAGE_SIDE 2^g, a unit at level L side LEAF 2^L */
export const PAGE_SIDE = 15.625;
export const LEAF = 250;

export const PACK_MAGIC = 'GMPK';
export const IDX_MAGIC = 'GMIX';
export const COL_MAGIC = 'GMCL';
export const VERSION = 1;
export const WORLD_VERSION = 4;
/** bytes of the .idx and .col prefix before their deflate stream */
export const PREFIX = 8;
export const PACK_TRAILER = 16;
export const IDX_HEADER = 40;
export const ROW_BYTES = 52;
export const CHILD_BYTES = 9;
export const DESCENDANT_BYTES = 11;
export const COL_HEADER = 60;
export const COL_CHANNELS = 12;

export const PAGE_HEADER = 128;
/** byte planes of a page payload, each count long */
export const PLANES = {
	position: 0,
	alpha: 6,
	rotationIndex: 7,
	rotation: 8,
	scale: 11,
	dc: 14,
	label: 17
};
export const BASE_PLANES = 17;
export const SH_COEFFS = 9;

/** splats per cluster: the pool's slot, the cull's unit and one projection workgroup */
export const CLUSTER = 256;
/** pool slots a page of count splats takes: whole clusters, at least one */
export const slots = (count: number) => Math.max(1, Math.ceil(count / CLUSTER)) * CLUSTER;

/**
 * pool record, little-endian u32 words, split over two storage buffers so each stays under the
 * 128 MiB default binding at the pool sizes we use.
 * geometry: w0 x u16 | y u16 << 16
 *           w1 z u16 | alpha u8 << 16 | rotation index << 24
 *           w2 rotation a | b << 8 | c << 16 | scale x << 24
 *           w3 scale y | scale z << 8
 * colour:   w0 dc r | g << 8 | b << 16 | sh0 << 24
 *           w1 sh1 .. sh4, w2 sh5 .. sh8, sh as i8 over the page's sh scale
 * bytes decode as in the file; dc and sh are recoded after the colour correction.
 */
export const GEOMETRY_WORDS = 4;
export const COLOUR_WORDS = 3;

/** DecodedPage.params: origin, step, scale min, scale max, dc min, dc max (3 each), sh scale (9) */
export const PARAMS = {
	origin: 0,
	step: 3,
	scaleMin: 6,
	scaleMax: 9,
	dcMin: 12,
	dcMax: 15,
	shScale: 18
};
export const PAGE_PARAMS = 27;

/** u32 words of common.wgsl's Page and Cluster */
export const PAGE_WORDS = 36;
export const CLUSTER_WORDS = 12;
/** bytes of common.wgsl's FrameUniforms */
export const FRAME_UNIFORM_BYTES = 336;
/** u32 words of common.wgsl's Projected */
export const PROJECTED_WORDS = 6;
/** vec4f slots shared by shade hooks */
export const PLUGIN_VEC4S = 16;

/** u32 word offsets in the work buffer; visible cluster ids start at WORK.list */
export const WORK = {
	visible: 0,
	projected: 4,
	drawArgs: 8,
	list: 16
};

/** bits of a sort key: reversed log view depth, so ascending keys run far to near */
export const KEY_BITS = 24;

/** px² added to a splat's 2d covariance */
export const LOW_PASS = 0.075;
