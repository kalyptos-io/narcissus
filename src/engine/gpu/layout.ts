// the gpu layouts the engine builds on a decoded page

import { CLUSTER, PARAMS, type DecodedPage } from '../../format/index.ts';

/** pool slots a page of count splats takes: whole clusters, at least one */
export const slots = (count: number) => Math.max(1, Math.ceil(count / CLUSTER)) * CLUSTER;

/** world origin of page as encoded, in the unit with south-west corner (e, n) */
export function baseOf(
	page: DecodedPage,
	unit: readonly [number, number]
): [number, number, number] {
	const o = PARAMS.origin;
	return [page.params[o] + unit[0], page.params[o + 1] + unit[1], page.params[o + 2]];
}

/** rgba 0 to 1 as wgsl's unpack4x8unorm reads it */
export function pack4x8unorm(rgba: readonly number[]): number {
	return (
		rgba.reduce(
			(word, v, k) => word | (Math.round(Math.min(1, Math.max(0, v)) * 255) << (8 * k)),
			0
		) >>> 0
	);
}

/** u32 words of common.wgsl's Page and Cluster */
export const PAGE_WORDS = 40;
export const CLUSTER_WORDS = 12;
/** bytes of common.wgsl's FrameUniforms */
export const FRAME_UNIFORM_BYTES = 352;
/** u32 words of common.wgsl's Projected */
export const PROJECTED_WORDS = 6;
/** vec4f slots shared by shade hooks */
export const PLUGIN_VEC4S = 16;

/** u32 word offsets in the work buffer; visible cluster ids start at WORK.list */
export const WORK = {
	visible: 0,
	sampled: 1,
	over: 2,
	rasterOver: 3,
	projected: 4,
	drawArgs: 8,
	list: 16
};

/** workgroups a dispatch row holds, common.wgsl's GROUPS_X */
const GROUPS_X = 65535;
/** x and y of a dispatch of count workgroups, which the shader numbers row by row */
export const groups = (count: number): [number, number] => [
	Math.min(count, GROUPS_X),
	Math.ceil(count / GROUPS_X)
];

/** bits of a sort key: reversed log view depth, so ascending keys run far to near */
export const KEY_BITS = 24;

/** px² added to a splat's 2d covariance */
export const LOW_PASS = 0.075;
