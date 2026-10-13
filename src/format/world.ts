import type { World, WorldRoot } from './types.ts';
import { parseUnitPath } from './idx.ts';
import { LEAF, VERSION } from './spec.ts';

/** the number version 1 carried before the format was public */
const EARLIER = 4;
const KNOWN = new Set(['version', 'crs', 'height', 'leaf', 'roots', 'extent']);

function fault(what: string): Error {
	return new Error(`This world has ${what}.`);
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

/** the directory of a world.json url, with its trailing slash and without query or fragment; unit paths join it */
export function directory(url: string): string {
	const path = url.split(/[?#]/)[0];
	return path.slice(0, path.lastIndexOf('/') + 1);
}

/** throws an Error with a user-facing message when json is not a version 1 world */
export function parseWorld(json: unknown): World {
	const w = record(json, 'an unreadable world.json');
	if (w.version !== VERSION && w.version !== EARLIER) {
		throw new Error(`This world is version ${String(w.version)}; narcissus reads ${VERSION}.`);
	}
	if (w.leaf !== LEAF) throw fault(`${String(w.leaf)} m leaf units, not ${LEAF} m`);
	if (!Array.isArray(w.roots) || w.roots.length === 0) throw fault('no roots');
	const extent = record(w.extent, 'no extent');
	return {
		version: VERSION,
		crs: text(w.crs, 'no coordinate system'),
		height: text(w.height, 'no height datum'),
		leaf: LEAF,
		roots: w.roots.map(root),
		extent: {
			e: range(extent.e, 'an invalid easting extent'),
			n: range(extent.n, 'an invalid northing extent'),
			h: range(extent.h, 'an invalid height extent')
		},
		extra: Object.fromEntries(Object.entries(w).filter(([member]) => !KNOWN.has(member)))
	};
}
