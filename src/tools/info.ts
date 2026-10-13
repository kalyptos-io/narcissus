// what a world holds, from its .idx files alone

import type { World } from '../format/index.ts';
import type { Fetch } from '../ports.ts';
import { openWorld, walk } from './walk.ts';

export interface Info {
	world: World;
	/** units by pyramid level */
	units: number[];
	/** pages and splats by global level g; level 0 is the world at full detail */
	levels: { pages: number; splats: number }[];
	/** bytes of every pack */
	bytes: number;
}

export async function info(source: Fetch, worldUrl: string): Promise<Info> {
	const world = await openWorld(source, worldUrl);
	const found: Info = { world, units: [], levels: [], bytes: 0 };
	for await (const { idx } of walk(source, worldUrl, world)) {
		found.units[idx.level] = (found.units[idx.level] ?? 0) + 1;
		found.bytes += idx.packSize;
		for (const row of idx.rows) {
			const level = (found.levels[row.g] ??= { pages: 0, splats: 0 });
			level.pages++;
			level.splats += row.count;
		}
	}
	// a level no unit holds is a hole in the arrays
	found.units = Array.from(found.units, (count) => count ?? 0);
	found.levels = Array.from(found.levels, (level) => level ?? { pages: 0, splats: 0 });
	return found;
}
