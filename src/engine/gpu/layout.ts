// the gpu layouts the engine builds on a decoded page

import { CLUSTER } from '../../format/index.ts';

/** pool slots a page of count splats takes: whole clusters, at least one */
export const slots = (count: number) => Math.max(1, Math.ceil(count / CLUSTER)) * CLUSTER;

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
