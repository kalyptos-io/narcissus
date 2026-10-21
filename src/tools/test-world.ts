// a small version 2 world on disk for the tools' tests: one level 1 root over two leaves

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
	deflate,
	encodeCol,
	encodeIdx,
	encodePack,
	encodePage,
	link,
	mulberry32,
	type Nodes
} from '../format/encode.ts';
import {
	childKey,
	contentHash,
	TOP_PAGE,
	unitKey,
	unitPath,
	type PageRow,
	type UnitKey
} from '../format/index.ts';

const E = 723000;
const N = 6177000;
/** fit splats in each of a leaf's two fine pages, in families of four */
const FITS = 24;
/** the sizes of the families of a leaf's band 1 page: twelve parents, one of them alone */
const SIZES = [3, 3, 3, 2, 1];

export interface Node {
	/** unit-local metres */
	position: [number, number, number];
	scale: number;
	opacity: number;
	children: number;
	link: number;
}

export interface Page {
	g: number;
	i: number;
	j: number;
	flags: number;
	nodes: Node[];
	/** in place of the box the writer works out */
	box?: Float32Array;
}

export interface Unit extends UnitKey {
	pages: Page[];
	/** quadrants of the children it names */
	children: number[];
	col: boolean;
}

/** the units, a root first; tests change them before write */
export function build(): Unit[] {
	const next = mulberry32(5);
	const leaves = [0, 1].map((q): Unit => {
		const fine = [0, 1].map((i): Page => {
			const nodes = Array.from({ length: FITS }, (): Node => {
				const position: Node['position'] = [
					(i + 0.1 + 0.8 * next()) * 15.625,
					(0.1 + 0.8 * next()) * 15.625,
					8 + 4 * next()
				];
				return {
					position,
					scale: 0.2 + 0.3 * next(),
					opacity: 0.3 + 0.6 * next(),
					children: 0,
					link: 0
				};
			});
			return { g: 0, i, j: 0, flags: 0, nodes };
		});
		const middle = fine.flatMap((page, row) =>
			chunk(page.nodes, 4).map(([start, family]) => merge(family, 0, row, start, next))
		);
		const coarse: Page = { g: 1, i: 0, j: 0, flags: 0, nodes: middle };
		return { level: 0, e: E + 250 * q, n: N, pages: [...fine, coarse], children: [], col: q === 0 };
	});
	// the leaves' top nodes, copied into the root's band 2, east of the first leaf for the second
	const band = leaves.map((leaf, q): Page => {
		const nodes = sizes(leaf.pages[2].nodes, SIZES).map(([start, family]) => {
			const top = merge(family, q + 1, 2, start, next);
			top.position[0] += 250 * q;
			return top;
		});
		return { g: 2, i: 4 * q, j: 0, flags: 0, nodes };
	});
	const crown = band.map((page, row) => merge(page.nodes, 0, row, 0, next));
	const top: Page = { g: 5, i: 0, j: 0, flags: TOP_PAGE, nodes: crown };
	const root: Unit = { level: 1, e: E, n: N, pages: [...band, top], children: [0, 1], col: false };
	return [root, ...leaves];
}

/** the units under dir with their world.json; returns the files, relative to it */
export async function write(dir: string, units: Unit[]): Promise<string[]> {
	const files: string[] = [];
	const put = (path: string, bytes: Uint8Array) => {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), bytes);
		files.push(path);
	};
	// children first, so a parent names their hashes
	const names = new Map<string, string>();
	for (const unit of [...units].reverse()) {
		let offset = 0;
		const pages = await Promise.all(unit.pages.map(async (page) => encoded(page)));
		const rows: PageRow[] = pages.map(({ row, blob }) => {
			const placed = { ...row, offset, length: blob.length };
			offset += blob.length;
			return placed;
		});
		const fit =
			unit.level === 0 ? unit.pages.flatMap((p) => p.nodes).filter((n) => !n.children).length : 0;
		const pack = encodePack(
			pages.map(({ blob }, r) => ({ row: rows[r], blob })),
			fit
		);
		const packName = contentHash(pack);
		put(unitPath(unit, packName, 'pack'), pack);
		let col: string | null = null;
		if (unit.col) {
			const bytes = await encodeCol({
				n: 2,
				pitch: 250,
				margin: 0,
				values: new Float32Array(48).fill(0.02)
			});
			col = contentHash(bytes);
			put(unitPath(unit, col, 'col'), bytes);
		}
		const idx = await encodeIdx({
			level: unit.level,
			e: unit.e,
			n: unit.n,
			pack: packName,
			packSize: pack.length,
			col,
			rows,
			children: unit.children.map((q) => ({
				quadrant: q,
				idx: names.get(unitKey(childKey(unit, q)))!
			})),
			descendants: []
		});
		const idxName = contentHash(idx);
		names.set(unitKey(unit), idxName);
		put(unitPath(unit, idxName, 'idx'), idx);
	}
	const [root] = units;
	const world = {
		version: 2,
		crs: 'EPSG:25832',
		height: 'DVR90',
		leaf: 250,
		roots: [
			{
				level: root.level,
				e: root.e,
				n: root.n,
				idx: unitPath(root, names.get(unitKey(root))!, 'idx')
			}
		],
		extent: { e: [E, E + 500], n: [N, N + 500], h: [0, 20] }
	};
	put('world.json', new TextEncoder().encode(JSON.stringify(world)));
	return files;
}

async function encoded(page: Page): Promise<{ row: PageRow; blob: Uint8Array }> {
	const n = page.nodes.length;
	const nodes: Nodes = {
		count: n,
		position: Float64Array.from(page.nodes.flatMap((node) => node.position)),
		rotation: Float32Array.from(page.nodes.flatMap(() => [1, 0, 0, 0])),
		scale: Float32Array.from(
			page.nodes.flatMap((node) => [0, 0, 0].map(() => Math.log(node.scale)))
		),
		opacity: Float32Array.from(page.nodes, (node) => node.opacity),
		dc: new Float32Array(3 * n).fill(0.1),
		sh: null,
		children: Uint8Array.from(page.nodes, (node) => node.children),
		links: Uint32Array.from(page.nodes, (node) => node.link)
	};
	const { payload, row } = encodePage(nodes, page);
	return { row: page.box ? { ...row, box: page.box } : row, blob: await deflate(payload) };
}

/** consecutive families of size, each with its first index */
function chunk(nodes: Node[], size: number): [number, Node[]][] {
	return sizes(nodes, new Array(Math.ceil(nodes.length / size)).fill(size));
}

function sizes(nodes: Node[], counts: number[]): [number, Node[]][] {
	let start = 0;
	return counts.map((count) => {
		const family: [number, Node[]] = [start, nodes.slice(start, start + count)];
		start += count;
		return family;
	});
}

/** a parent over family, linked at start of row in unit (0 its own, 1 + q a child); some flat-topped */
function merge(family: Node[], unit: number, row: number, start: number, next: () => number): Node {
	const mean = (a: number) =>
		family.reduce((sum, node) => sum + node.position[a], 0) / family.length;
	const spread = Math.max(
		...family.map((node) => Math.hypot(node.position[0] - mean(0), node.position[1] - mean(1)))
	);
	return {
		position: [mean(0), mean(1), mean(2)],
		scale: Math.max(...family.map((node) => node.scale)) + spread / 2,
		opacity: next() < 0.3 ? 1.5 + next() : 0.6 + 0.4 * next(),
		children: family.length,
		link: link(unit, row, start)
	};
}
