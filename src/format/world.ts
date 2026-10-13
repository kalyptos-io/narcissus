import type { World, WorldRoot } from './types.ts';
import { parseUnitPath } from './idx.ts';
import { LEAF, WORLD_VERSION } from './spec.ts';

const CRS = 'EPSG:25832';
const HEIGHT = 'DVR90';
const REBUILD = 'Rebuild it with the current guldmund.';

function fault(what: string): Error {
	return new Error(`This world has ${what}. ${REBUILD}`);
}

function record(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fault(what);
	return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
	if (typeof value !== 'string' || value === '') throw fault(what);
	return value;
}

function range(value: unknown, what: string): [number, number] {
	if (
		!Array.isArray(value) ||
		value.length !== 2 ||
		!value.every(Number.isFinite) ||
		value[0] > value[1]
	) {
		throw fault(what);
	}
	return [value[0], value[1]];
}

function root(value: unknown): WorldRoot {
	const r = record(value, 'an invalid root');
	const { level, e, n } = r;
	if (
		!Number.isInteger(level) ||
		!Number.isInteger(e) ||
		!Number.isInteger(n) ||
		(level as number) < 0
	) {
		throw fault('an invalid root');
	}
	const key = { level: level as number, e: e as number, n: n as number };
	const side = LEAF * 2 ** key.level;
	const idx = text(r.idx, 'a root without an index');
	const path = parseUnitPath(idx);
	if (
		key.e % side !== 0 ||
		key.n % side !== 0 ||
		!idx.endsWith('.idx') ||
		!path ||
		path.level !== key.level ||
		path.e !== key.e ||
		path.n !== key.n
	) {
		throw fault('a root whose index does not match its unit');
	}
	return { ...key, idx };
}

/** throws an Error with a user-facing message when json is not a version 4 world */
export function parseWorld(json: unknown): World {
	const w = record(json, 'an unreadable world.json');
	if (w.version !== WORLD_VERSION) {
		const v = String(w.version);
		throw new Error(`This world is version ${v}, this viewer reads ${WORLD_VERSION}. ${REBUILD}`);
	}
	if (w.crs !== CRS) throw fault(`coordinates in ${String(w.crs)}, not ${CRS}`);
	if (w.height !== HEIGHT) throw fault(`heights in ${String(w.height)}, not ${HEIGHT}`);
	if (w.leaf !== LEAF) throw fault(`${String(w.leaf)} m leaf units, not ${LEAF} m`);
	if (!Array.isArray(w.roots) || w.roots.length === 0) throw fault('no roots');
	const extent = record(w.extent, 'no extent');
	const attribution = record(w.attribution, 'no attribution');
	return {
		version: WORLD_VERSION,
		crs: CRS,
		height: HEIGHT,
		leaf: LEAF,
		roots: w.roots.map(root),
		extent: {
			e: range(extent.e, 'an invalid easting extent'),
			n: range(extent.n, 'an invalid northing extent'),
			h: range(extent.h, 'an invalid height extent')
		},
		attribution: {
			retrieved: text(attribution.retrieved, 'no retrieval date'),
			epoch: text(attribution.epoch, 'no imagery epoch')
		}
	};
}
