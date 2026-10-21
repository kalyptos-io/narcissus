// a cut of a world as a gaussian-splat ply, the file other splat tools read

import {
	C0,
	childKey,
	decodePage,
	directory,
	inflate,
	linkRanks,
	parseCol,
	parseIdx,
	readSplat,
	unitKey,
	unitPath,
	type Col,
	type DecodedPage,
	type Idx,
	type PageRow,
	type SplatValues,
	type World
} from '../format/index.ts';
import type { Fetch } from '../ports.ts';
import { linked, openWorld, type Family } from './walk.ts';

export interface PlyOptions {
	/** metres: a node of larger radius is refined into its family; 0, every fit splat, when left out */
	detail?: number;
	/** west, south, east, north: only nodes of pages that touch this box, and only families in such pages, are written */
	box?: readonly [number, number, number, number];
	/** told once at the end when nodes past opacity 1 were written at the most a ply holds */
	warn?: (message: string) => void;
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
/** opacity 0 and 1 have no logit; the nearest codes a byte can hold stand in */
const ALPHA = [0.5 / 255, 254.5 / 255] as const;

/**
 * a splat in the ply's frame, x east, y down, z north: the frame splat tools expect, a quarter
 * turn about east from the world's east, north, up. position is relative to origin
 */
export function plySplat(s: SplatValues, origin: readonly [number, number], out: Float32Array) {
	const [w, x, y, z] = s.rotation;
	const alpha = Math.min(ALPHA[1], Math.max(ALPHA[0], s.opacity));
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
 * the ply in parts: its header, then the nodes of one page a part. positions are relative to the
 * origin its header names, whole metres at the south-west of what is written
 */
export async function* exportPly(
	source: Fetch,
	worldUrl: string,
	options: PlyOptions = {}
): AsyncGenerator<Uint8Array> {
	const { detail = 0, box, warn } = options;
	const world = await openWorld(source, worldUrl);
	const base = directory(worldUrl);
	// the cut twice: once to count it for the header, without colour, once to write it
	let count = 0;
	for await (const { picks } of cut(source, base, world, detail, box, false)) count += picks.length;
	const origin = [
		Math.floor(box ? box[0] : world.extent.e[0]),
		Math.floor(box ? box[1] : world.extent.n[0])
	] as const;
	yield new TextEncoder().encode(
		[
			'ply',
			'format binary_little_endian 1.0',
			`comment a guldmund tree cut at ${detail} m detail in ${world.crs}, heights in ${world.height}`,
			'comment x east, y down, z north, in metres',
			`comment origin ${origin[0]} ${origin[1]}: add it to x and z for easting and northing`,
			`element vertex ${count}`,
			...PROPERTIES.map((name) => `property float ${name}`),
			'end_header',
			''
		].join('\n')
	);

	const width = PROPERTIES.length;
	let flat = 0;
	for await (const { idx, page, picks } of cut(source, base, world, detail, box, true)) {
		const part = new Float32Array(picks.length * width);
		picks.forEach((t, k) => {
			const splat = readSplat(page, t);
			if (splat.opacity > 1) flat++;
			// a page's positions are local to its unit
			splat.position[0] += idx.e;
			splat.position[1] += idx.n;
			plySplat(splat, origin, part.subarray(k * width, (k + 1) * width));
		});
		yield new Uint8Array(part.buffer);
	}
	if (flat) warn?.(`${flat} nodes past opacity 1 written at opacity 1: a ply holds no flat tops`);
}

/** the nodes of a cut a page at a time: every node of radius detail or less whose ancestors are all larger, from the roots' top pages down; colour applies each unit's .col */
async function* cut(
	source: Fetch,
	base: string,
	world: World,
	detail: number,
	box: PlyOptions['box'],
	colour: boolean
): AsyncGenerator<{ idx: Idx; page: DecodedPage; picks: number[] }> {
	const touches = (idx: Idx, { box: b }: PageRow) =>
		!box ||
		(idx.e + b[0] <= box[2] &&
			idx.e + b[3] >= box[0] &&
			idx.n + b[1] <= box[3] &&
			idx.n + b[4] >= box[1]);
	// units a level at a time, each with the families its parent's cut reaches in it; a root starts at its top page
	let level: { path: string; families: Family[] | null }[] = world.roots.map((root) => ({
		path: root.idx,
		families: null
	}));
	while (level.length > 0) {
		const below = new Map<string, { path: string; families: Family[] }>();
		for (const { path, families } of level) {
			const idx = await parseIdx(await source(base + path, null));
			const pack = base + unitPath(idx, idx.pack, 'pack');
			const col: Col | null =
				colour && idx.col
					? await parseCol(await source(base + unitPath(idx, idx.col, 'col'), null))
					: null;
			const pages = new Map<number, { page: DecodedPage; ranks: Uint32Array }>();
			const load = async (r: number) => {
				const row = idx.rows[r];
				const blob = await source(pack, [row.offset, row.offset + row.length]);
				const page = decodePage(await inflate(blob), col);
				pages.set(r, { page, ranks: linkRanks(page.nodes.counts) });
				return pages.get(r)!;
			};
			const picks = new Map<number, number[]>();
			const last = idx.rows.length - 1;
			const stack: Family[] = families ?? [[last, 0, idx.rows[last].count]];
			while (stack.length) {
				const [r, start, count] = stack.pop()!;
				if (!touches(idx, idx.rows[r])) continue;
				const { page, ranks } = pages.get(r) ?? (await load(r));
				for (let t = start; t < start + count; t++) {
					if (!page.nodes.counts[t] || page.nodes.radii[ranks[t]] <= detail) {
						if (!picks.has(r)) picks.set(r, []);
						picks.get(r)!.push(t);
						continue;
					}
					const { family, quadrant } = linked(page.nodes, ranks, t);
					if (quadrant < 0) {
						stack.push(family);
						continue;
					}
					const key = childKey(idx, quadrant);
					const name = unitKey(key);
					const named = idx.children.find((child) => child.quadrant === quadrant);
					if (!named) throw new Error(`${path} links to a child it does not name`);
					if (!below.has(name))
						below.set(name, { path: unitPath(key, named.idx, 'idx'), families: [] });
					below.get(name)!.families.push(family);
				}
			}
			for (const [r, at] of [...picks].sort((a, b) => a[0] - b[0])) {
				yield { idx, page: pages.get(r)!.page, picks: at };
			}
		}
		level = [...below.values()];
	}
}
