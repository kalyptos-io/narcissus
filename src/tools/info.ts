// what a world holds, band by band, from its .idx files and every page

import {
	decodePage,
	directory,
	fromHalf,
	inflate,
	unitPath,
	GEOMETRY_WORDS,
	type World
} from '../format/index.ts';
import type { Fetch } from '../ports.ts';
import { openWorld, walk } from './walk.ts';

export interface Band {
	rows: number;
	nodes: number;
	/** nodes with children, and those with one child */
	parents: number;
	unary: number;
	/** nodes past opacity 1, flat-topped */
	flat: number;
	/** blob bytes */
	bytes: number;
}

export interface Info {
	world: World;
	/** units by pyramid level */
	units: number[];
	/** by band g; band 0 holds the finest fit splats */
	bands: Band[];
	/** bytes of every pack */
	bytes: number;
}

export async function info(source: Fetch, worldUrl: string): Promise<Info> {
	const world = await openWorld(source, worldUrl);
	const base = directory(worldUrl);
	const found: Info = { world, units: [], bands: [], bytes: 0 };
	for await (const { idx } of walk(source, worldUrl, world)) {
		found.units[idx.level] = (found.units[idx.level] ?? 0) + 1;
		found.bytes += idx.packSize;
		const pack = await source(base + unitPath(idx, idx.pack, 'pack'), null);
		for (const row of idx.rows) {
			const band = (found.bands[row.g] ??= empty());
			const blob = pack.subarray(row.offset, row.offset + row.length);
			const { count, geometry, nodes } = decodePage(await inflate(blob), null);
			band.rows++;
			band.nodes += count;
			band.parents += nodes.links.length;
			band.bytes += row.length;
			for (let t = 0; t < count; t++) {
				if (nodes.counts[t] === 1) band.unary++;
				if (fromHalf(geometry[t * GEOMETRY_WORDS + 3] >>> 16) > 1) band.flat++;
			}
		}
	}
	// a level or band nothing holds is a hole in the arrays
	found.units = Array.from(found.units, (count) => count ?? 0);
	found.bands = Array.from(found.bands, (band) => band ?? empty());
	return found;
}

function empty(): Band {
	return { rows: 0, nodes: 0, parents: 0, unary: 0, flat: 0, bytes: 0 };
}
