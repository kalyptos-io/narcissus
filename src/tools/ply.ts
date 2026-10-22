// one level of a world as a gaussian-splat ply, the file other splat tools read

import {
	C0,
	decodePage,
	directory,
	inflate,
	parseCol,
	readSplat,
	unitPath,
	type Col,
	type Idx,
	type PageRow,
	type SplatValues
} from '../format/index.ts';
import type { Fetch } from '../ports.ts';
import { openWorld, walk } from './walk.ts';

export interface PlyOptions {
	/** the global level g to write; 0, the full detail, when left out */
	level?: number;
	/** west, south, east, north: only pages that touch this box are written, each one whole */
	box?: readonly [number, number, number, number];
}

const PROPERTIES = [
	...['x', 'y', 'z'],
	...[0, 1, 2].map((c) => `f_dc_${c}`),
	...Array.from({ length: 9 }, (_, k) => `f_rest_${k}`),
	'opacity',
	...[0, 1, 2].map((a) => `scale_${a}`),
	...[0, 1, 2, 3].map((k) => `rot_${k}`)
];
const HALF = Math.SQRT1_2;
/** alpha 0 and 1 have no logit; the nearest codes a byte can hold stand in */
const ALPHA = [0.5 / 255, 254.5 / 255] as const;

/**
 * a splat in the ply's frame, x east, y down, z north: the frame splat tools expect, a quarter
 * turn about east from the world's east, north, up. position is relative to origin
 */
export function plySplat(s: SplatValues, origin: readonly [number, number], out: Float32Array) {
	const [w, x, y, z] = s.rotation;
	const alpha = Math.min(ALPHA[1], Math.max(ALPHA[0], s.alpha));
	out[0] = s.position[0] - origin[0];
	out[1] = -s.position[2];
	out[2] = s.position[1] - origin[1];
	for (let c = 0; c < 3; c++) {
		out[3 + c] = (s.colour[c] - 0.5) / C0;
		out[6 + 3 * c] = s.sh[3 * c + 1];
		out[7 + 3 * c] = -s.sh[3 * c];
		out[8 + 3 * c] = s.sh[3 * c + 2];
		out[16 + c] = Math.log(s.scale[c]);
	}
	out[15] = Math.log(alpha / (1 - alpha));
	// (HALF, HALF, 0, 0) times the rotation
	out[19] = HALF * (w - x);
	out[20] = HALF * (w + x);
	out[21] = HALF * (y - z);
	out[22] = HALF * (y + z);
}

/**
 * the ply in parts: its header, then the splats of one page a part. splat positions are relative
 * to the origin its header names, whole metres at the south-west of what is written
 */
export async function* exportPly(
	source: Fetch,
	worldUrl: string,
	options: PlyOptions = {}
): AsyncGenerator<Uint8Array> {
	const { level = 0, box } = options;
	const world = await openWorld(source, worldUrl);
	const base = directory(worldUrl);
	const touches = (idx: Idx, { box: b }: PageRow) =>
		!box ||
		(idx.e + b[0] <= box[2] &&
			idx.e + b[3] >= box[0] &&
			idx.n + b[1] <= box[3] &&
			idx.n + b[4] >= box[1]);
	const chosen: { idx: Idx; rows: PageRow[] }[] = [];
	let count = 0;
	for await (const { idx } of walk(source, worldUrl, world)) {
		const rows = idx.rows.filter((row) => row.g === level && touches(idx, row));
		if (rows.length === 0) continue;
		chosen.push({ idx, rows });
		for (const row of rows) count += row.count;
	}
	const origin = [
		Math.floor(box ? box[0] : world.extent.e[0]),
		Math.floor(box ? box[1] : world.extent.n[0])
	] as const;
	yield new TextEncoder().encode(
		[
			'ply',
			'format binary_little_endian 1.0',
			`comment level ${level} of a guldmund tree in ${world.crs}, heights in ${world.height}`,
			'comment x east, y down, z north, in metres',
			`comment origin ${origin[0]} ${origin[1]}: add it to x and z for easting and northing`,
			`element vertex ${count}`,
			...PROPERTIES.map((name) => `property float ${name}`),
			'end_header',
			''
		].join('\n')
	);

	const width = PROPERTIES.length;
	for (const { idx, rows } of chosen) {
		const pack = base + unitPath(idx, idx.pack, 'pack');
		const col: Col | null = idx.col
			? await parseCol(await source(base + unitPath(idx, idx.col, 'col'), null))
			: null;
		for (const row of rows) {
			const blob = await source(pack, [row.offset, row.offset + row.length]);
			const page = decodePage(await inflate(blob), col);
			const part = new Float32Array(page.count * width);
			for (let t = 0; t < page.count; t++) {
				const splat = readSplat(page, t);
				// a page's positions are local to its unit
				splat.position[0] += idx.e;
				splat.position[1] += idx.n;
				plySplat(splat, origin, part.subarray(t * width, (t + 1) * width));
			}
			yield new Uint8Array(part.buffer);
		}
	}
}
