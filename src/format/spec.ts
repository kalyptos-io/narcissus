// the constants of guldmund trees version 2 (docs/format.md) and the layout of a decoded page

export const C0 = 0.28209479177387814;
export const C1 = 0.4886025119029199;

/** metres; a page at level g has side PAGE_SIDE 2^g, a unit at level L side LEAF 2^L */
export const PAGE_SIDE = 15.625;
export const LEAF = 250;

export const PACK_MAGIC = 'GMPK';
export const IDX_MAGIC = 'GMIX';
export const COL_MAGIC = 'GMCL';
export const ATR_MAGIC = 'GMAT';
/** narcissus's own object id sidecar, docs/embedding.md */
export const IDS_MAGIC = 'NIDS';
export const VERSION = 1;
/** the newest .idx: version 2 names the unit's .atr */
export const IDX_VERSION = 2;
/** bytes of the .idx, .col and .ids prefix before their deflate stream */
export const PREFIX = 8;
export const PACK_TRAILER = 16;
export const IDX_HEADER = 40;
export const IDX_HEADER_V2 = 52;
export const ROW_BYTES = 52;
export const CHILD_BYTES = 9;
export const DESCENDANT_BYTES = 11;
export const COL_HEADER = 60;
export const COL_CHANNELS = 12;
export const ATR_TRAILER = 24;
export const ATR_CHUNK_BYTES = 20;

/** .atr chunk encodings */
export const ENCODING = { plain: 0, dictionary: 1, sparse: 2 } as const;
/** dictionary entries at most, and at most for u8 indices */
export const DICTIONARY_MAX = 65536;
export const DICTIONARY_U8 = 256;
/** bytes of each scalar type */
export const SCALAR_BYTES = {
	u8: 1,
	u16: 2,
	u32: 4,
	i8: 1,
	i16: 2,
	i32: 4,
	f16: 2,
	f32: 4
} as const;

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

/**
 * pool record, little-endian u32 words, split over two storage buffers so each stays under the
 * 128 MiB default binding at the pool sizes we use.
 * geometry: w0 x u16 | y u16 << 16
 *           w1 z u16 | alpha u8 << 16 | rotation index << 24
 *           w2 rotation a | b << 8 | c << 16 | scale x << 24
 *           w3 scale y | scale z << 8 | object << 16
 * colour:   w0 dc r | g << 8 | b << 16 | sh0 << 24
 *           w1 sh1 .. sh4, w2 sh5 .. sh8, sh as i8 over the page's sh scale
 * bytes decode as in the file; dc and sh are recoded after the colour correction. object is the
 * host's id from its .ids, 0 without one.
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

/**
 * PageAttribute.descriptor: encoding bits 0-1, type bits 2-5 (ATTRIBUTE_TYPES, 0 for absent),
 * components bits 6-8, count bits 9-31: the dictionary's entries, the sparse rows, or a plain
 * records stream's rows. PageAttribute.words, word-aligned:
 * plain:      the values, back to back
 * dictionary: the k values, then the row indices, u8 when k <= 256, else u16
 * sparse:     the m rows, then their values
 * records:    plain the rows + 1 word offsets, sparse the m rows and m + 1 word offsets, then the
 *             records from the word after them, each padded with 0 to whole words
 */
export const ATTRIBUTE_TYPES = {
	u8: 1,
	u16: 2,
	u32: 3,
	i8: 4,
	i16: 5,
	i32: 6,
	f16: 7,
	f32: 8,
	records: 9
} as const;
export const DESCRIPTOR = { encoding: 0, type: 2, components: 6, count: 9 };
export const DESCRIPTOR_COUNT_MAX = 2 ** 23 - 1;
