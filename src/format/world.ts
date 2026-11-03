import type { Attribute, Scalar, World, WorldRoot } from './types.ts';
import { parseUnitPath } from './idx.ts';
import { LEAF, SCALAR_BYTES, VERSION } from './spec.ts';

const KNOWN = new Set(['version', 'crs', 'height', 'leaf', 'roots', 'extent', 'attributes']);
const RULES = new Set(['preserved', 'aggregated', 'unavailable']);
/** <producer>.<name>, at most 255 bytes as an .atr stores it */
const NAME = /^[^.\s]+(\.[^.\s]+)+$/;
const NAME_BYTES = 255;
/** the integer range of each integer type */
const INTEGERS: Partial<Record<Scalar, [number, number]>> = {
	u8: [0, 0xff],
	u16: [0, 0xffff],
	u32: [0, 0xffffffff],
	i8: [-0x80, 0x7f],
	i16: [-0x8000, 0x7fff],
	i32: [-0x80000000, 0x7fffffff]
};

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

function attribute(name: string, value: unknown): Attribute {
	const what = `an invalid attribute ${name}`;
	if (!NAME.test(name) || new TextEncoder().encode(name).length > NAME_BYTES) throw fault(what);
	const a = record(value, what);
	if (typeof a.rule !== 'string' || !RULES.has(a.rule)) throw fault(what);
	const rule = a.rule as Attribute['rule'];
	if (a.type === 'records') {
		if (a.components !== undefined || a.default !== undefined) throw fault(what);
		return { type: 'records', components: 0, default: [], rule };
	}
	if (typeof a.type !== 'string' || !Object.hasOwn(SCALAR_BYTES, a.type)) throw fault(what);
	const type = a.type as Scalar;
	const components = a.components;
	if (!Number.isInteger(components) || (components as number) < 1 || (components as number) > 4) {
		throw fault(what);
	}
	const given = typeof a.default === 'number' ? Array(components).fill(a.default) : a.default;
	if (!Array.isArray(given) || given.length !== components || !given.every(Number.isFinite)) {
		throw fault(what);
	}
	const bounds = INTEGERS[type];
	if (bounds && !given.every((v) => Number.isInteger(v) && v >= bounds[0] && v <= bounds[1])) {
		throw fault(what);
	}
	return { type, components: components as number, default: given as number[], rule };
}

function attributes(value: unknown): Record<string, Attribute> {
	if (value === undefined) return {};
	const declared = record(value, 'an invalid attributes member');
	return Object.fromEntries(
		Object.entries(declared).map(([name, a]) => [name, attribute(name, a)])
	);
}

/** the directory of a world.json url, with its trailing slash and without query or fragment; unit paths join it */
export function directory(url: string): string {
	const path = url.split(/[?#]/)[0];
	return path.slice(0, path.lastIndexOf('/') + 1);
}

/** throws an Error with a user-facing message when json is not a version 1 world */
export function parseWorld(json: unknown): World {
	const w = record(json, 'an unreadable world.json');
	if (w.version !== VERSION) {
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
		attributes: attributes(w.attributes),
		extra: Object.fromEntries(Object.entries(w).filter(([member]) => !KNOWN.has(member)))
	};
}
