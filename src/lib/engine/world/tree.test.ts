import { describe, expect, it } from 'vitest';
import { unitPath } from '../format/idx.ts';
import { LEAF } from '../format/spec.ts';
import type { UnitKey, World } from '../types.ts';
import { hash, unit } from './test-tree.ts';
import { Tree, unitKey, type PageNode, type UnitNode } from './tree.ts';

const E = 720000;
const N = 6176000;
const OPEN = ['unknown', 'unknown', 'unknown', 'unknown'];
const NONE = ['none', 'none', 'none', 'none'];

function world(...roots: UnitKey[]): World {
	return {
		version: 4,
		crs: 'EPSG:25832',
		height: 'DVR90',
		leaf: LEAF,
		roots: roots.map((key) => ({ ...key, idx: `u/${key.level}/${key.e}/${key.n}.idx` })),
		extent: { e: [E, E + 2000], n: [N, N + 2000], h: [0, 5] },
		attribution: { retrieved: '2026-10-08', epoch: 'test' }
	};
}

function page(unit: UnitNode, g: number, i: number, j: number): PageNode {
	const found = unit.pages.find((p) => p.g === g && p.row.i === i && p.row.j === j);
	if (!found) throw new Error(`no page ${g}/${i}/${j}`);
	return found;
}

/** ids of the four pages at the south-west corner of a unit's level g, by quadrant */
function corner(unit: UnitNode, g: number): number[] {
	return [0, 1, 2, 3].map((q) => page(unit, g, q & 1, q >> 1).id);
}

const links = (p: PageNode) =>
	p.children.map((c) => (c === undefined ? 'unknown' : c === null ? 'none' : c.id));

describe('tree', () => {
	it('links a leaf under its parent and leaves unknown children open', () => {
		const key = { level: 1, e: E, n: N };
		const tree = new Tree(world(key));
		const parent = tree.add(unit(key, { children: [0, 1, 2] }), 'p');
		expect(tree.roots).toHaveLength(64);
		expect(links(page(parent, 2, 0, 0))).toEqual(OPEN);
		expect(links(page(parent, 2, 7, 7))).toEqual(NONE);

		const idx = unit({ level: 0, e: E, n: N });
		idx.rows = idx.rows.filter((row) => !(row.g === 1 && row.i === 3 && row.j === 0));
		const leaf = tree.add(idx, 'l');
		const top = page(parent, 2, 0, 0);
		expect(leaf.parent).toBe(parent);
		expect(links(top)).toEqual(corner(leaf, 1));
		expect(page(leaf, 1, 0, 0).parent).toBe(top);
		const next = page(parent, 2, 1, 0);
		expect(next.children[0]).toBe(page(leaf, 1, 2, 0));
		expect(next.children[1]).toBeNull();
		expect(page(leaf, 1, 1, 1).children[3]).toBe(page(leaf, 0, 3, 3));
		expect(links(page(leaf, 0, 3, 3))).toEqual(NONE);
		expect(page(leaf, 0, 3, 3).box).toEqual(
			Float64Array.of(E + 46.875, N + 46.875, 0, E + 62.5, N + 62.5, 5)
		);

		const east = tree.add(unit({ level: 0, e: E + 250, n: N }), 'e');
		expect(page(east, 1, 0, 0).parent).toBe(page(parent, 2, 4, 0));
		expect(page(parent, 2, 4, 0).children[0]).toBe(page(east, 1, 0, 0));
		expect([...tree.pages].every(([id, p]) => p.id === id)).toBe(true);
		expect(tree.pages.size).toBe(64 + 319 + 320);
	});

	it('links the extra levels of a root inside its unit', () => {
		const key = { level: 1, e: E, n: N };
		const tree = new Tree(world(key));
		const root = tree.add(unit(key, { extra: 3 }), 'r');
		expect(tree.roots.map((p) => p.g)).toEqual([5]);
		const [top] = tree.roots;
		expect(top.parent).toBeNull();
		expect(links(top)).toEqual(corner(root, 4));
		expect(page(root, 3, 3, 3).parent).toBe(page(root, 4, 1, 1));
		expect(page(root, 2, 0, 0).parent).toBe(page(root, 3, 0, 0));
		expect(links(page(root, 2, 0, 0))).toEqual(OPEN);
	});

	it('links descendants that arrive before their parents', () => {
		const key = { level: 2, e: E, n: N };
		const tree = new Tree(world(key));
		const leaf = tree.add(unit({ level: 0, e: E, n: N }), 'l');
		expect(leaf.parent).toBeNull();
		expect(page(leaf, 1, 0, 0).parent).toBeNull();
		expect(tree.roots).toHaveLength(0);

		const mid = tree.add(unit({ level: 1, e: E, n: N }), 'm');
		expect(leaf.parent).toBe(mid);
		expect(page(leaf, 1, 0, 0).parent).toBe(page(mid, 2, 0, 0));
		expect(page(mid, 2, 0, 0).children[0]).toBe(page(leaf, 1, 0, 0));
		expect(page(mid, 2, 0, 0).parent).toBeNull();

		const root = tree.add(unit(key), 'r');
		expect(mid.parent).toBe(root);
		expect(page(mid, 2, 0, 0).parent).toBe(page(root, 3, 0, 0));
		expect(page(root, 3, 0, 0).children[0]).toBe(page(mid, 2, 0, 0));
		expect(tree.roots).toHaveLength(64);
		const named = tree.wanted().map(unitKey);
		expect(named).not.toContain(unitKey(leaf));
		expect(named).not.toContain(unitKey(mid));
	});

	it('wants named units not yet added, over the pages of their nearest added ancestor', () => {
		const key = { level: 2, e: E, n: N };
		const tree = new Tree(world(key));
		const root = tree.add(unit(key), 'r');
		const wanted = () => new Map(tree.wanted().map((w) => [unitKey(w), w]));
		expect(wanted().size).toBe(20);

		const childKey = { level: 1, e: E + 500, n: N };
		const child = wanted().get(unitKey(childKey))!;
		expect(child.path).toBe(unitPath(childKey, hash(childKey), 'idx'));
		expect(child.over).toHaveLength(16);
		for (const p of child.over) {
			expect(p.unit).toBe(root);
			expect(p.row.i >= 4 && p.row.j < 4).toBe(true);
		}
		const leafKey = { level: 0, e: E + 250, n: N + 250 };
		expect(wanted().get(unitKey(leafKey))!.over).toHaveLength(4);

		const mid = tree.add(unit({ level: 1, e: E, n: N }), 'm');
		expect(wanted().size).toBe(19);
		const leaf = wanted().get(unitKey(leafKey))!;
		expect(leaf.over).toHaveLength(16);
		expect(leaf.over.every((p) => p.unit === mid)).toBe(true);
		expect(wanted().get(unitKey({ level: 0, e: E + 750, n: N }))!.over[0].unit).toBe(root);
	});

	it('finds the ground under the finest page over a point', () => {
		const key = { level: 1, e: E, n: N };
		const tree = new Tree(world(key));
		const parent = unit(key, { children: [0, 1, 2] });
		for (const row of parent.rows) row.box[2] = 1;
		tree.add(parent, 'p');
		const leaf = unit({ level: 0, e: E, n: N });
		leaf.rows.find((row) => row.g === 0 && row.i === 3 && row.j === 2)!.box[2] = 3.5;
		tree.add(leaf, 'l');
		expect(tree.ground(E + 50, N + 40)).toBe(3.5);
		expect(tree.ground(E + 10, N + 10)).toBe(0);
		expect(tree.ground(E + 300, N + 10)).toBe(1);
		expect(tree.ground(E - 1, N)).toBeUndefined();
	});

	it('prunes a leaf unit, then its parent, and never a root', () => {
		const key = { level: 2, e: E, n: N };
		const tree = new Tree(world(key));
		const root = tree.add(unit(key), 'r');
		const mid = tree.add(unit({ level: 1, e: E, n: N }), 'm');
		const leaf = tree.add(unit({ level: 0, e: E, n: N }), 'l');
		const top = page(mid, 2, 0, 0);
		expect(tree.prune(new Set([top.id]))).toEqual(leaf.pages.map((p) => p.id));
		expect(tree.units.has(unitKey(leaf))).toBe(false);
		expect(links(top)).toEqual(OPEN);
		expect(tree.pages.size).toBe(64 + 64);

		expect(tree.prune(new Set())).toEqual(mid.pages.map((p) => p.id));
		expect(links(page(root, 3, 0, 0))).toEqual(OPEN);
		expect(tree.prune(new Set())).toEqual([]);
		expect(tree.units.size).toBe(1);
		expect(tree.pages.size).toBe(64);
		expect(tree.roots.every((p) => tree.pages.get(p.id) === p)).toBe(true);
	});

	it('keeps a unit with a kept page and every unit above it', () => {
		const key = { level: 3, e: E, n: N };
		const tree = new Tree(world(key));
		const chain = [
			tree.add(unit(key), 'r'),
			tree.add(unit({ level: 2, e: E, n: N }), 'l2'),
			tree.add(unit({ level: 1, e: E, n: N }), 'l1'),
			tree.add(unit({ level: 0, e: E, n: N }), 'l0')
		];
		const sibling = tree.add(unit({ level: 0, e: E + 250, n: N }), 's');
		// a leaf waiting for its parent still holds the unit two levels up
		const east = tree.add(unit({ level: 2, e: E + 1000, n: N }), 'e2');
		const waiting = tree.add(unit({ level: 0, e: E + 1000, n: N }), 'w');
		const keep = new Set([page(chain[3], 0, 5, 5).id, page(waiting, 0, 0, 0).id]);
		expect(tree.prune(keep)).toEqual(sibling.pages.map((p) => p.id));
		for (const node of [...chain, east, waiting]) expect(tree.units.get(unitKey(node))).toBe(node);
	});

	it('wants a pruned unit again and links it again on add', () => {
		const key = { level: 2, e: E, n: N };
		const tree = new Tree(world(key));
		const root = tree.add(unit(key), 'r');
		const mid = tree.add(unit({ level: 1, e: E, n: N }), 'm');
		const leafKey = { level: 0, e: E, n: N };
		const leaf = tree.add(unit(leafKey), 'l');
		const find = () => tree.wanted().find((w) => unitKey(w) === unitKey(leafKey));
		expect(find()).toBeUndefined();

		tree.prune(new Set([page(mid, 2, 0, 0).id]));
		const back = find()!;
		expect(back.path).toBe(unitPath(leafKey, hash(leafKey), 'idx'));
		expect(back.over).toHaveLength(16);
		expect(back.over.every((p) => p.unit === mid)).toBe(true);

		const again = tree.add(unit(leafKey), back.path);
		expect(find()).toBeUndefined();
		expect(page(mid, 2, 0, 0).children[0]).toBe(page(again, 1, 0, 0));
		const first = Math.max(...leaf.pages.map((p) => p.id));
		expect(Math.min(...again.pages.map((p) => p.id))).toBeGreaterThan(first);

		tree.prune(new Set());
		const over = find()!.over;
		expect(over).toHaveLength(4);
		expect(over.every((p) => p.unit === root)).toBe(true);
	});
});
