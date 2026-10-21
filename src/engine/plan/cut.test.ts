import { describe, expect, it } from 'vitest';
import { link, mulberry32 } from '../../format/encode.ts';
import type { PageNodes } from '../../format/index.ts';
import { slots } from '../gpu/layout.ts';
import { CAP, Cut, cutView, T_MIN, type CutResult, type CutView, type UnitInfo } from './cut.ts';

/** a node of the test forest, world metres */
interface Node {
	centre: [number, number, number];
	radius: number;
	family: Node[] | null;
	/** where it is stored: page id and index */
	page: number;
	index: number;
}

interface Forest {
	units: UnitInfo[];
	pages: Map<number, PageNodes>;
	/** page id to its unit corner */
	corners: Map<number, [number, number]>;
	tops: Node[];
	fits: number;
	/** the root's top page */
	top: number;
}

/** families of 1 to 5 consecutive nodes */
function chunk(nodes: Node[], next: () => number): Node[][] {
	const families: Node[][] = [];
	for (let at = 0; at < nodes.length;) {
		const count = 1 + Math.floor(5 * next());
		families.push(nodes.slice(at, at + count));
		at += count;
	}
	return families;
}

function parentOf(family: Node[]): Node {
	const centre = [0, 1, 2].map((a) => family.reduce((s, m) => s + m.centre[a], 0) / family.length);
	const spread = Math.max(
		...family.map((m) => Math.hypot(...m.centre.map((c, a) => c - centre[a])))
	);
	const radius = 1.6 * Math.max(...family.map((m) => m.radius)) + spread;
	return { centre: centre as Node['centre'], radius, family, page: -1, index: -1 };
}

/**
 * a root at level 1 over four leaves of `fits` fit splats each: leaf families in bands 0 and 1,
 * the leaves' tops copied into the root's band 2, its own tops in its top page; every band split
 * over pages of whole families
 */
function forest(seed: number, fits = 300): Forest {
	const next = mulberry32(seed);
	const pages = new Map<number, PageNodes>();
	const corners = new Map<number, [number, number]>();
	let id = 0;
	/** families into pages of a unit, rows appended to info */
	const place = (info: UnitInfo, families: Node[][], top = false) => {
		const split = top ? 1 : 1 + Math.floor(3 * next());
		const per = Math.ceil(families.length / split);
		for (let p = 0; p < split; p++) {
			const members = families.slice(p * per, (p + 1) * per).flat();
			if (!members.length) continue;
			const page = id++;
			members.forEach((node, index) => Object.assign(node, { page, index }));
			info.rows.push({ id: page, count: members.length, top });
			corners.set(page, [info.e, info.n]);
			pages.set(page, { members } as unknown as PageNodes);
		}
	};
	const sorted = (nodes: Node[]) =>
		nodes.sort((a, b) => a.centre[0] - b.centre[0] || a.centre[1] - b.centre[1]);

	const root: UnitInfo = {
		level: 1,
		e: 0,
		n: 0,
		root: true,
		rows: [],
		children: [],
		descendants: [[], [], [], []]
	};
	const leaves: UnitInfo[] = [];
	const tops: Node[] = [];
	const fams3: Node[][] = [];
	for (let q = 0; q < 4; q++) {
		const leaf: UnitInfo = {
			level: 0,
			e: 250 * (q & 1),
			n: 250 * (q >> 1),
			root: false,
			rows: [],
			children: [null, null, null, null],
			descendants: [[], [], [], []]
		};
		const splats: Node[] = Array.from({ length: fits }, () => ({
			centre: [leaf.e + 250 * next(), leaf.n + 250 * next(), 10 * next()],
			radius: 0.2 + 0.2 * next(),
			family: null,
			page: -1,
			index: -1
		}));
		const fams1 = chunk(sorted(splats), next);
		const parents1 = fams1.map(parentOf);
		const fams2 = chunk(sorted(parents1), next);
		const parents2 = fams2.map(parentOf);
		place(leaf, fams1);
		place(leaf, fams2);
		leaves.push(leaf);
		tops.push(...parents2);
	}
	fams3.push(...chunk(sorted(tops), next));
	const parents3 = fams3.map(parentOf);
	place(root, fams3);
	place(root, [parents3], true);
	root.children = leaves.map((leaf) => `u/0/${leaf.e}/${leaf.n}.idx`);

	// each stored node's count and link, each page's arrays
	const unitOf = new Map<number, UnitInfo>();
	for (const info of [root, ...leaves]) for (const row of info.rows) unitOf.set(row.id, info);
	const rowOf = (page: number) => unitOf.get(page)!.rows.findIndex((row) => row.id === page);
	for (const [page, holder] of pages) {
		const members = (holder as unknown as { members: Node[] }).members;
		const corner = corners.get(page)!;
		const parents = members.filter((m) => m.family);
		const nodes: PageNodes = {
			counts: Uint8Array.from(members, (m) => m.family?.length ?? 0),
			centres: Float32Array.from(
				parents.flatMap((m) => [m.centre[0] - corner[0], m.centre[1] - corner[1], m.centre[2]])
			),
			radii: Float32Array.from(parents, (m) => m.radius),
			links: Uint32Array.from(parents, (m) => {
				const first = m.family![0];
				const own = unitOf.get(page)!;
				const there = unitOf.get(first.page)!;
				const q = there === own ? -1 : (there.e - own.e) / 250 + (2 * (there.n - own.n)) / 250;
				return link(q + 1, rowOf(first.page), first.index);
			})
		};
		pages.set(page, nodes);
	}
	return {
		units: [root, ...leaves],
		pages,
		corners,
		tops: parents3,
		fits: 4 * fits,
		top: root.rows.at(-1)!.id
	};
}

/** a 1920 x 1080 view at the viewer's fov from eye, yaw and pitch in degrees */
function look([e, n, h]: [number, number, number], yaw = 0, pitch = -60): CutView {
	return cutView({ e, n, h, yaw, pitch, fov: 45 }, 1920, 1080, 1);
}

/** the size the cut gives a node, from format.md's radius and the brief's weight */
function size(node: Node, view: CutView): number {
	const d = [0, 1, 2].map((a) => node.centre[a] - view.eye[a]);
	const r = view.rotation;
	const depth = -(r[6] * d[0] + r[7] * d[1] + r[8] * d[2]);
	let weight = 0.05;
	if (depth > 0) {
		const x = Math.abs(view.p00 * (r[0] * d[0] + r[1] * d[1] + r[2] * d[2]));
		const y = Math.abs(view.p11 * (r[3] * d[0] + r[4] * d[1] + r[5] * d[2]));
		weight += 0.95 * (depth / Math.max(depth, x, y)) ** 2;
	}
	const focal = Math.max(view.p00 * view.width, view.p11 * view.height) / 2;
	return (2 * node.radius * focal * weight) / Math.hypot(...d);
}

const OVER = look([250, -150, 300]);

/** a cut told of every unit and of the pages resident says */
function cutOf(f: Forest, resident: (page: number) => boolean = () => true): Cut {
	const cut = new Cut();
	for (const info of f.units) cut.unit(info);
	for (const [id, nodes] of f.pages) if (resident(id)) cut.page(id, nodes);
	return cut;
}

/** drawn bits of every page the plans so far left set */
function drawn(results: CutResult[]): Map<number, Uint32Array> {
	const masks = new Map<number, Uint32Array>();
	for (const { masks: changed } of results) {
		for (const { id, mask } of changed) {
			if (mask.length) masks.set(id, mask);
			else masks.delete(id);
		}
	}
	return masks;
}

const isDrawn = (masks: Map<number, Uint32Array>, node: Node) =>
	((masks.get(node.page)?.[node.index >> 5] ?? 0) >>> (node.index & 31)) & 1;

/** drawn nodes under node, after checking each path holds one drawn node */
function walk(
	node: Node,
	masks: Map<number, Uint32Array>,
	resident: (page: number) => boolean
): number {
	const here = isDrawn(masks, node);
	const below = node.family && resident(node.family[0].page);
	if (here) {
		if (below)
			for (const m of node.family!) expect(under(m, masks), 'drawn under a drawn node').toBe(0);
		return 1;
	}
	expect(below, 'a path with no drawn node').toBeTruthy();
	return node.family!.reduce((sum, m) => sum + walk(m, masks, resident), 0);
}

function under(node: Node, masks: Map<number, Uint32Array>): number {
	let count = isDrawn(masks, node);
	for (const m of node.family ?? []) if (m.page >= 0) count += under(m, masks);
	return count;
}

describe('cut', () => {
	it('draws one node on every path from the top page to a fit splat, within the cap', () => {
		for (let seed = 1; seed <= 12; seed++) {
			const f = forest(seed);
			const next = mulberry32(seed + 100);
			const absent = new Set([...f.pages.keys()].filter((id) => id !== f.top && next() < 0.3));
			const resident = (id: number) => !absent.has(id);
			for (const budget of [60, 200, 700, 5000]) {
				const result = cutOf(f, resident).plan({ views: [OVER], budget, capacity: 1e9 });
				const masks = drawn([result]);
				const total = f.tops.reduce((sum, top) => sum + walk(top, masks, resident), 0);
				expect(result.planned).toBe(total);
				expect(result.planned).toBeLessThanOrEqual(
					Math.max(f.tops.length, Math.floor(CAP * budget))
				);
				expect(result.load.every((id) => absent.has(id))).toBe(true);
			}
		}
	});

	it('refines to every fit splat when the budget holds them, and to the budget when it does not', () => {
		const f = forest(3);
		const all = cutOf(f).plan({ views: [OVER], budget: 10_000, capacity: 1e9 });
		expect(all).toMatchObject({ planned: f.fits, missing: 0, load: [], idx: [], detail: T_MIN });
		const some = cutOf(f).plan({ views: [OVER], budget: 400, capacity: 1e9 });
		expect(some.planned).toBeGreaterThanOrEqual(400);
		expect(some.planned).toBeLessThanOrEqual(440);
		expect(some.detail).toBeGreaterThan(T_MIN);
	});

	it('keeps a parent whose family is not resident drawn, and wants the page', () => {
		const f = forest(4);
		const fine = f.units[1].rows[0].id;
		const result = cutOf(f, (id) => id !== fine).plan({
			views: [OVER],
			budget: 10_000,
			capacity: 1e9
		});
		expect(result.load).toEqual([fine]);
		const masks = drawn([result]);
		let blocked = 0;
		const visit = (node: Node) => {
			if (!node.family) return;
			if (node.family[0].page === fine) {
				expect(isDrawn(masks, node)).toBe(1);
				blocked++;
			} else node.family.forEach(visit);
		};
		f.tops.forEach(visit);
		expect(result.missing).toBe(blocked);
		expect(blocked).toBeGreaterThan(0);
	});

	it('keeps what it reads and wants within the pool, and counts as missing what waits on a page', () => {
		for (let seed = 1; seed <= 6; seed++) {
			const f = forest(seed);
			const next = mulberry32(seed + 200);
			const absent = new Set([...f.pages.keys()].filter((id) => id !== f.top && next() < 0.3));
			const resident = (id: number) => !absent.has(id);
			const pageSlots = (id: number) => slots(f.pages.get(id)!.counts.length);
			for (let capacity = pageSlots(f.top); capacity < 64 * pageSlots(f.top); capacity *= 2) {
				const result = cutOf(f, resident).plan({ views: [OVER], budget: 10_000, capacity });
				const taken = [...result.touched, ...result.load].reduce(
					(sum, id) => sum + pageSlots(id),
					0
				);
				expect(taken).toBeLessThanOrEqual(capacity);
				const masks = drawn([result]);
				f.tops.forEach((top) => walk(top, masks, resident));
				const load = new Set(result.load);
				let waiting = 0;
				const visit = (node: Node) => {
					if (!node.family) return;
					if (isDrawn(masks, node)) waiting += load.has(node.family[0].page) ? 1 : 0;
					else node.family.forEach(visit);
				};
				f.tops.forEach(visit);
				// a node too small to refine draws on beside a wanted family, and is not missing
				expect(result.missing).toBeLessThanOrEqual(waiting);
				expect(result.missing > 0).toBe(result.load.length > 0);
			}
		}
	});

	it('plans the same cut from the same messages, and sends no masks for the same view again', () => {
		const f = forest(6);
		const request = { views: [OVER, look([260, -120, 290])], budget: 500, capacity: 1e9 };
		const a = cutOf(f);
		const first = a.plan(request);
		expect(cutOf(f).plan(request)).toEqual({ ...first, ms: expect.any(Number) });
		a.verdict(true);
		const again = a.plan(request);
		expect(again.masks).toEqual([]);
		expect({ ...again, masks: first.masks, ms: first.ms }).toEqual(first);
	});

	it('sends the changes against the masks the pool took', () => {
		const f = forest(7);
		const cut = cutOf(f);
		const near = { views: [look([100, 50, 80])], budget: 300, capacity: 1e9 };
		const far = { views: [look([250, -900, 900])], budget: 300, capacity: 1e9 };
		const first = cut.plan(near);
		cut.verdict(true);
		const moved = cut.plan(far);
		expect(moved.masks.length).toBeGreaterThan(0);
		// the pool dropped it, so the same plan's changes come again
		cut.verdict(false);
		expect(cut.plan(far).masks).toEqual(moved.masks);
		cut.verdict(true);
		const back = cut.plan(near);
		expect(drawn([first])).toEqual(drawn([first, moved, back]));
	});

	it('forgets an evicted page, which then draws its parents in its place', () => {
		const f = forest(8);
		const cut = cutOf(f);
		const request = { views: [OVER], budget: 10_000, capacity: 1e9 };
		const before = cut.plan(request);
		cut.verdict(true);
		const fine = f.units[2].rows[0].id;
		cut.evict(fine);
		const after = cut.plan(request);
		expect(after.load).toEqual([fine]);
		expect(after.masks.some(({ id }) => id === fine)).toBe(false);
		const masks = drawn([before, after]);
		masks.delete(fine);
		f.tops.forEach((top) => walk(top, masks, (id) => id !== fine));
	});

	it('ranks the pages it wants by the largest node waiting on each', () => {
		const f = forest(9);
		const leaves = new Set(f.units.slice(1).flatMap((u) => u.rows.map((row) => row.id)));
		const view = look([30, 20, 60], 45, -40);
		const result = cutOf(f, (id) => !leaves.has(id)).plan({
			views: [view],
			budget: 10_000,
			capacity: 1e9
		});
		const priority = new Map<number, number>();
		const visit = (node: Node) => {
			if (!node.family) return;
			const page = node.family[0].page;
			if (leaves.has(page)) {
				const s = size(node, view);
				if (s > T_MIN) priority.set(page, Math.max(priority.get(page) ?? 0, s));
			} else node.family.forEach(visit);
		};
		f.tops.forEach(visit);
		const expected = [...priority].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([id]) => id);
		expect(result.load).toEqual(expected);
	});

	it('wants a root top page that is not resident, and draws nothing', () => {
		const f = forest(10);
		const result = cutOf(f, (id) => id !== f.top).plan({
			views: [OVER],
			budget: 500,
			capacity: 1e9
		});
		expect(result).toMatchObject({ load: [f.top], planned: 0, masks: [], touched: [] });
	});

	it('wants an unknown child .idx, and the ones below it for a node far above the threshold', () => {
		const f = forest(11);
		const [root] = f.units;
		const deep = { ...root, descendants: [['u/below/0'], [], [], []] };
		const cut = new Cut();
		cut.unit(deep);
		for (const row of root.rows) cut.page(row.id, f.pages.get(row.id)!);
		const far = cut.plan({
			views: [look([125, 125, 3000], 0, -89)],
			budget: 10_000,
			capacity: 1e9
		});
		expect(far.idx).toEqual(expect.arrayContaining(root.children as string[]));
		expect(far.idx).not.toContain('u/below/0');
		expect(far.missing).toBeGreaterThan(0);
		const near = cut.plan({ views: [look([125, 125, 20], 0, -89)], budget: 10_000, capacity: 1e9 });
		expect(near.idx.indexOf('u/below/0')).toBeGreaterThan(near.idx.indexOf(root.children[0]!));
	});

	it('takes the larger size over the camera and the one ahead', () => {
		const f = forest(12);
		const here = look([250, -900, 900]);
		const ahead = look([200, 100, 60]);
		const request = (views: CutView[]) => ({ views, budget: 400, capacity: 1e9 });
		const alone = cutOf(f).plan(request([here]));
		const both = cutOf(f).plan(request([here, ahead]));
		expect(cutOf(f).plan(request([ahead, here]))).toEqual({ ...both, ms: expect.any(Number) });
		const fits: Node[] = [];
		const gather = (node: Node) => (node.family ? node.family.forEach(gather) : fits.push(node));
		f.tops.forEach(gather);
		const near = (masks: Map<number, Uint32Array>) =>
			fits.filter((n) => isDrawn(masks, n) && Math.hypot(n.centre[0] - 200, n.centre[1] - 100) < 60)
				.length;
		expect(near(drawn([both]))).toBeGreaterThan(near(drawn([alone])));
	});
});
