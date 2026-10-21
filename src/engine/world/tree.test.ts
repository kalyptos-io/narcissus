import { describe, expect, it } from 'vitest';
import { unitPath } from '../../format/index.ts';
import { hash, unit, world } from './test-tree.ts';
import { Tree, unitKey, type UnitNode } from './tree.ts';

const E = 720000;
const N = 6176000;

const children = (node: UnitNode) =>
	node.children.map((c) => (c === undefined ? 'unknown' : c === null ? 'none' : unitKey(c)));

describe('tree', () => {
	it('links a leaf under its parent and leaves named children open', () => {
		const key = { level: 1, e: E, n: N };
		const tree = new Tree(world(key));
		const parent = tree.add(unit(key, { top: true, children: [0, 1, 2] }), 'p');
		expect(tree.roots).toEqual([parent]);
		expect(children(parent)).toEqual(['unknown', 'unknown', 'unknown', 'none']);
		expect(parent.pages.map((p) => p.row.g)).toEqual([...new Array(64).fill(2), 3]);

		const leaf = tree.add(unit({ level: 0, e: E + 250, n: N }), 'l');
		expect(leaf.parent).toBe(parent);
		expect(parent.children[1]).toBe(leaf);
		expect(children(leaf)).toEqual(['none', 'none', 'none', 'none']);
		expect(leaf.pages).toHaveLength(256 + 64);
		expect(leaf.pages[3].row).toMatchObject({ g: 0, i: 1, j: 1 });
		expect(leaf.pages[3].box).toEqual(
			Float64Array.of(E + 250 + 15.625, N + 15.625, 0, E + 250 + 31.25, N + 31.25, 5)
		);
		expect([...tree.pages].every(([id, p]) => p.id === id)).toBe(true);
		expect(tree.pages.size).toBe(65 + 320);
	});

	it('links descendants that arrive before their parents', () => {
		const key = { level: 2, e: E, n: N };
		const tree = new Tree(world(key));
		const leaf = tree.add(unit({ level: 0, e: E, n: N }), 'l');
		expect(leaf.parent).toBeNull();
		expect(tree.roots).toHaveLength(0);

		const mid = tree.add(unit({ level: 1, e: E, n: N }), 'm');
		expect(leaf.parent).toBe(mid);
		expect(mid.children[0]).toBe(leaf);
		expect(mid.parent).toBeNull();

		const root = tree.add(unit(key, { top: true }), 'r');
		expect(mid.parent).toBe(root);
		expect(root.children[0]).toBe(mid);
		expect(tree.roots).toEqual([root]);
		const named = tree.wanted().map(unitKey);
		expect(named).not.toContain(unitKey(leaf));
		expect(named).not.toContain(unitKey(mid));
	});

	it('wants named units not yet added, through their nearest added namer', () => {
		const key = { level: 2, e: E, n: N };
		const tree = new Tree(world(key));
		tree.add(unit(key, { top: true }), 'r');
		const wanted = () => new Map(tree.wanted().map((w) => [unitKey(w), w]));
		expect(wanted().size).toBe(20);
		const childKey = { level: 1, e: E + 500, n: N };
		expect(wanted().get(unitKey(childKey))!.path).toBe(unitPath(childKey, hash(childKey), 'idx'));

		tree.add(unit({ level: 1, e: E, n: N }), 'm');
		expect(wanted().size).toBe(19);
		expect(wanted().has(unitKey({ level: 0, e: E + 250, n: N + 250 }))).toBe(true);
	});

	it('tells its listener of every unit it adds and prunes', () => {
		const key = { level: 1, e: E, n: N };
		const heard: string[] = [];
		const tree = new Tree(world(key), {
			added: (node, root) => heard.push(`+${unitKey(node)}${root ? ' root' : ''}`),
			pruned: (units) => heard.push(`-${units.map(unitKey).join(',')}`)
		});
		tree.add(unit(key, { top: true }), 'r');
		tree.add(unit({ level: 0, e: E, n: N }), 'l');
		tree.prune(new Set());
		expect(heard).toEqual([`+1/${E}/${N} root`, `+0/${E}/${N}`, `-0/${E}/${N}`]);
	});

	it('finds the ground under the finest page over a point', () => {
		const key = { level: 1, e: E, n: N };
		const tree = new Tree(world(key));
		const parent = unit(key, { top: true, children: [0, 1, 2] });
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

	it('loads the units over a point, and only those', async () => {
		const key = { level: 2, e: E, n: N };
		const tree = new Tree(world(key));
		tree.add(unit(key, { top: true }), 'r');
		const leaf = unit({ level: 0, e: E + 250, n: N });
		for (const row of leaf.rows) row.box[2] = 7;
		const units = [unit({ level: 1, e: E, n: N }), leaf];
		const path = (idx: (typeof units)[number]) => unitPath(idx, hash(idx), 'idx');
		const fetched: string[] = [];
		const fetch = async (asked: string) => {
			fetched.push(asked);
			const found = units.find((idx) => path(idx) === asked);
			if (!found) throw new Error(`no ${asked}`);
			return found;
		};
		expect(tree.ground(E + 300, N + 10)).toBe(0);
		await tree.load(E + 300, N + 10, fetch);
		expect(tree.ground(E + 300, N + 10)).toBe(7);
		expect(fetched.sort()).toEqual(units.map(path).sort());
	});

	it('prunes a leaf unit, then its parent, and never a root', () => {
		const key = { level: 2, e: E, n: N };
		const tree = new Tree(world(key));
		const root = tree.add(unit(key, { top: true }), 'r');
		const mid = tree.add(unit({ level: 1, e: E, n: N }), 'm');
		const leaf = tree.add(unit({ level: 0, e: E, n: N }), 'l');
		expect(tree.prune(new Set([mid.pages[0].id]))).toEqual([leaf]);
		expect(tree.units.has(unitKey(leaf))).toBe(false);
		expect(mid.children[0]).toBeUndefined();
		expect(tree.pages.size).toBe(65 + 64);

		expect(tree.prune(new Set())).toEqual([mid]);
		expect(root.children[0]).toBeUndefined();
		expect(tree.prune(new Set())).toEqual([]);
		expect(tree.units.size).toBe(1);
		expect(tree.pages.size).toBe(65);
	});

	it('keeps a unit with a kept page and every unit above it', () => {
		const key = { level: 3, e: E, n: N };
		const tree = new Tree(world(key));
		const chain = [
			tree.add(unit(key, { top: true }), 'r'),
			tree.add(unit({ level: 2, e: E, n: N }), 'l2'),
			tree.add(unit({ level: 1, e: E, n: N }), 'l1'),
			tree.add(unit({ level: 0, e: E, n: N }), 'l0')
		];
		const sibling = tree.add(unit({ level: 0, e: E + 250, n: N }), 's');
		// a leaf waiting for its parent still holds the unit two levels up
		const east = tree.add(unit({ level: 2, e: E + 1000, n: N }), 'e2');
		const waiting = tree.add(unit({ level: 0, e: E + 1000, n: N }), 'w');
		const keep = new Set([chain[3].pages[100].id, waiting.pages[0].id]);
		expect(tree.prune(keep)).toEqual([sibling]);
		for (const node of [...chain, east, waiting]) expect(tree.units.get(unitKey(node))).toBe(node);
	});

	it('wants a pruned unit again and links it again on add', () => {
		const key = { level: 2, e: E, n: N };
		const tree = new Tree(world(key));
		tree.add(unit(key, { top: true }), 'r');
		const mid = tree.add(unit({ level: 1, e: E, n: N }), 'm');
		const leafKey = { level: 0, e: E, n: N };
		const leaf = tree.add(unit(leafKey), 'l');
		const find = () => tree.wanted().find((w) => unitKey(w) === unitKey(leafKey));
		expect(find()).toBeUndefined();

		tree.prune(new Set([mid.pages[0].id]));
		const back = find()!;
		expect(back.path).toBe(unitPath(leafKey, hash(leafKey), 'idx'));

		const again = tree.add(unit(leafKey), back.path);
		expect(find()).toBeUndefined();
		expect(mid.children[0]).toBe(again);
		const first = Math.max(...leaf.pages.map((p) => p.id));
		expect(Math.min(...again.pages.map((p) => p.id))).toBeGreaterThan(first);
	});
});
