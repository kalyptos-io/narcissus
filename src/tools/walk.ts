// the units of a world from its roots down, and the families a page's links reach

import {
	directory,
	linkRow,
	linkStart,
	linkUnit,
	namedUnits,
	parseIdx,
	parseWorld,
	unitPath,
	type Idx,
	type PageNodes,
	type World
} from '../format/index.ts';
import type { Fetch } from '../ports.ts';

export interface Unit {
	/** of its .idx, relative to world.json */
	path: string;
	idx: Idx;
	/** the .idx file as read */
	bytes: Uint8Array;
}

/** a family by its page row, first node and count, in the unit that stores it */
export type Family = [row: number, start: number, count: number];

/** the family parent t of a page refines into, and the quadrant of the child unit storing it, -1 for its own; ranks from linkRanks */
export function linked(
	nodes: PageNodes,
	ranks: Uint32Array,
	t: number
): { family: Family; quadrant: number } {
	const link = nodes.links[ranks[t]];
	return {
		family: [linkRow(link), linkStart(link), nodes.counts[t]],
		quadrant: linkUnit(link) - 1
	};
}

/** .idx files read at a time */
const ABREAST = 16;

export async function openWorld(source: Fetch, worldUrl: string): Promise<World> {
	const bytes = await source(worldUrl, null);
	return parseWorld(JSON.parse(new TextDecoder().decode(bytes)));
}

/**
 * every unit the roots of world reach, a parent before its children. an .idx that does not load
 * goes to fault, and nothing below it is reached; without fault it throws
 */
export async function* walk(
	source: Fetch,
	worldUrl: string,
	world: World,
	fault?: (path: string, error: unknown) => void
): AsyncGenerator<Unit> {
	const base = directory(worldUrl);
	const load = async (path: string): Promise<Unit | null> => {
		try {
			const bytes = await source(base + path, null);
			return { path, idx: await parseIdx(bytes), bytes };
		} catch (error) {
			if (!fault) throw error;
			fault(path, error);
			return null;
		}
	};
	let level = world.roots.map((root) => root.idx);
	while (level.length > 0) {
		const below: string[] = [];
		for (let at = 0; at < level.length; at += ABREAST) {
			for (const unit of await Promise.all(level.slice(at, at + ABREAST).map(load))) {
				if (!unit) continue;
				yield unit;
				// namedUnits lists the children first
				for (const { key, hash } of namedUnits(unit.idx).slice(0, unit.idx.children.length)) {
					below.push(unitPath(key, hash, 'idx'));
				}
			}
		}
		level = below;
	}
}
