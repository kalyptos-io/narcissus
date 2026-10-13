import { describe, expect, it } from 'vitest';
import { LEAF, PAGE_SIDE, slots } from '../format/spec.ts';
import { view as viewMatrix } from '../math/mat4.ts';
import type { UnitKey } from '../types.ts';
import { unit } from '../world/test-tree.ts';
import { Tree, type PageNode } from '../world/tree.ts';
import { HOLD, MARGIN, Planner, type Plan, type PlanOptions, type View } from './cut.ts';
import { FADE_MS, Fader } from './draw.ts';
import { footprint } from './footprint.ts';

const E = 720000;
const N = 6176000;
const COUNT = 20_000;
const UNBOUND = { budget: 1e12, capacity: 1e12, now: 0 };
const rad = Math.PI / 180;

/** a world of one root with its extra levels down to one page, nothing below it added yet */
function rooted(root: UnitKey, count = COUNT): Tree {
	const side = LEAF * 2 ** root.level;
	const tree = new Tree({
		version: 4,
		crs: 'EPSG:25832',
		height: 'DVR90',
		leaf: LEAF,
		roots: [{ ...root, idx: 'root.idx' }],
		extent: { e: [root.e, root.e + side], n: [root.n, root.n + side], h: [0, 5] },
		attribution: { retrieved: '2026-10-08', epoch: 'test' }
	});
	tree.add(unit(root, { count, extra: 3 }), 'root.idx');
	return tree;
}

const twoKm = () => rooted({ level: 3, e: E, n: N });

/** a 1000 px square view with a 90 degree fov, in a floating origin under the eye */
function look(eye: readonly [number, number, number], yaw: number, pitch: number): View {
	const origin = [Math.round(eye[0]), Math.round(eye[1]), 0] as const;
	const local = [eye[0] - origin[0], eye[1] - origin[1], eye[2]] as const;
	const view = viewMatrix(new Float64Array(16), local, yaw * rad, pitch * rad);
	return { origin, view, width: 1000, height: 1000, tan: 1, near: 0.5, far: 2000 };
}

/** plans, loads and fetches what each plan asks for until nothing is left to ask */
function settle(
	tree: Tree,
	view: View,
	options: PlanOptions,
	check?: (plan: Plan, resident: Set<number>) => void
): Plan {
	const planner = new Planner();
	const resident = new Set<number>();
	for (let round = 0; round < 64; round++) {
		const plan = planner.plan(tree, view, (id) => resident.has(id), options);
		check?.(plan, resident);
		if (!plan.load.length && !plan.idx.length) return plan;
		for (const page of plan.load) resident.add(page.id);
		for (const wanted of plan.idx) tree.add(unit(wanted, { count: COUNT }), wanted.path);
	}
	throw new Error('the plan did not settle');
}

function square(page: PageNode): [number, number, number] {
	const side = PAGE_SIDE * 2 ** page.g;
	return [page.unit.e + page.row.i * side, page.unit.n + page.row.j * side, side];
}

function at(cut: PageNode[], e: number, n: number): PageNode {
	const found = cut.find((page) => {
		const [x, y, side] = square(page);
		return e >= x && e < x + side && n >= y && n < y + side;
	});
	if (!found) throw new Error(`no page over ${e} ${n}`);
	return found;
}

/** the cut's pages within 200 m of (e, n), by level and global grid position */
function around(cut: PageNode[], e: number, n: number): string[] {
	const keys: string[] = [];
	for (const page of cut) {
		const [x, y, side] = square(page);
		if (x >= e + 200 || x + side <= e - 200 || y >= n + 200 || y + side <= n - 200) continue;
		keys.push(`${page.g}/${x / side}/${y / side}`);
	}
	return keys.sort();
}

const oblique = look([E + 500, N + 200, 20], 0, -15);
const down = look([E + 1100, N + 1100, 300], 0, -90);

describe('planner', () => {
	it('refines toward the camera', () => {
		const plan = settle(twoKm(), oblique, UNBOUND);
		expect(at(plan.cut, E + 500, N + 230).g).toBeLessThan(at(plan.cut, E + 500, N + 1700).g);
	});

	it('refines toward the screen centre', () => {
		const plan = settle(twoKm(), down, UNBOUND);
		expect(at(plan.cut, E + 1100, N + 1100).g).toBeLessThan(at(plan.cut, E + 1370, N + 1100).g);
	});

	it('keeps the splats on screen inside the budget', () => {
		const budget = 200_000;
		expect(settle(twoKm(), oblique, UNBOUND).planned).toBeGreaterThan(budget);
		const plan = settle(twoKm(), oblique, { ...UNBOUND, budget });
		expect(plan.planned).toBeGreaterThan(0);
		expect(plan.planned).toBeLessThanOrEqual(budget);
	});

	it('plans the same cut again once settled under a budget', () => {
		// a page refined last plan must not rank ahead of the refinements that freed its budget
		const view = look([E + 700, N + 600, 20], 30, -15);
		const options = { ...UNBOUND, budget: 240_000 };
		const tree = twoKm();
		const planner = new Planner();
		const resident = new Set<number>();
		const plan = () => planner.plan(tree, view, (id) => resident.has(id), options);
		let last = plan();
		for (let round = 0; round < 64 && (last.load.length || last.idx.length); round++) {
			for (const page of last.load) resident.add(page.id);
			for (const wanted of last.idx) tree.add(unit(wanted, { count: COUNT }), wanted.path);
			last = plan();
		}
		expect(plan().cut).toEqual(last.cut);
	});

	it('keeps the kept pages inside the capacity', () => {
		const capacity = 300_000;
		const tree = twoKm();
		const plan = settle(tree, oblique, { ...UNBOUND, capacity });
		const kept = [...plan.keep].reduce((sum, id) => sum + slots(tree.pages.get(id)!.row.count), 0);
		expect(kept).toBeGreaterThan(0);
		expect(kept).toBeLessThanOrEqual(capacity);
	});

	it('loads a page only once its parent is resident', () => {
		let loads = 0;
		settle(twoKm(), oblique, UNBOUND, (plan, resident) => {
			for (const page of plan.load) {
				loads++;
				expect(page.parent === null || resident.has(page.parent.id)).toBe(true);
			}
		});
		expect(loads).toBeGreaterThan(0);
	});

	it('keeps the cut and every ancestor of it', () => {
		const plan = settle(twoKm(), oblique, UNBOUND);
		for (const page of plan.cut) {
			expect(plan.keep.has(page.id)).toBe(true);
			for (let up = page.parent; up; up = up.parent) expect(plan.keep.has(up.id)).toBe(true);
		}
	});

	it('keeps a refinement through the margin so it does not flip at the threshold', () => {
		const near = look([E + 125, N + 125, 400], 0, -90);
		const high = look([E + 125, N + 125, 440], 0, -90);
		const need = (view: View) => {
			const box = [-125, -125, 0, 125, 125, 5];
			const { pixels, weight } = footprint(box, view.view, 1000, 1000, 1, 0.5, 2000, 1.1);
			return pixels * weight;
		};
		const count = Math.round((need(near) + need(high)) / 2);
		expect(count).toBeLessThan(need(near));
		expect(count).toBeGreaterThan(need(high));
		expect(count).toBeLessThan(need(high) * MARGIN);

		const tree = rooted({ level: 0, e: E, n: N }, count);
		const [root] = tree.roots;
		const resident = (id: number) => id === root.id;
		const refined = (planner: Planner, view: View) =>
			!planner.plan(tree, view, resident, UNBOUND).cut.includes(root);
		const planner = new Planner();
		expect(refined(planner, near)).toBe(true);
		expect(refined(planner, high)).toBe(true);
		expect(refined(new Planner(), high)).toBe(false);
	});

	it('refines only the quadrants in view, and the page draws the rest', () => {
		const tree = rooted({ level: 0, e: E, n: N });
		const [root] = tree.roots;
		// a corner of the root's south-west quadrant from 40 m up, the fringe inside that quadrant
		const plan = settle(tree, look([E + 40, N + 40, 40], 0, -90), UNBOUND);
		expect(plan.keep.has(root.id)).toBe(true);
		expect(plan.cut.includes(root)).toBe(false);
		expect(plan.cut.every((page) => square(page)[0] < E + 125 && square(page)[1] < N + 125)).toBe(
			true
		);
		const fader = new Fader();
		const resident = (id: number) => plan.keep.has(id);
		fader.update(plan.cut, resident, 0, 1e12);
		const { drawn } = fader.update(plan.cut, resident, FADE_MS, 1e12);
		// factors by quadrant from the low byte: the south-west one handed to its child
		expect(drawn.find((d) => d.id === root.id)?.factors).toBe(0xffffff00);
	});

	it('loads the fringe once the screen has its detail and the camera rests', () => {
		const onScreen = (page: PageNode) => {
			const box = Array.from(page.box, (v, k) => v - oblique.origin[k % 3]);
			return footprint(box, oblique.view, 1000, 1000, 1, 0.5, 2000, 1).pixels > 0;
		};
		const fringe = ({ load }: Plan) => load.filter((page) => !onScreen(page));
		let loads = 0;
		const moving = { ...UNBOUND, predicted: oblique };
		const plan = settle(twoKm(), oblique, moving, (step) => {
			loads += step.load.length;
			expect(fringe(step)).toEqual([]);
			expect(step.missing).toBe(step.load.reduce((sum, page) => sum + page.row.count, 0));
		});
		expect(loads).toBeGreaterThan(0);
		expect(plan.missing).toBe(0);
		let fringed = false;
		settle(twoKm(), oblique, UNBOUND, (step) => {
			if (step.missing > 0) expect(fringe(step)).toEqual([]);
			else if (fringe(step).length) fringed = true;
		});
		expect(fringed).toBe(true);
	});

	it('holds an off-screen refinement for HOLD ms, then lets it go', () => {
		const tree = rooted({ level: 0, e: E, n: N }, 1);
		const [root] = tree.roots;
		const resident = (id: number) => id === root.id;
		const below = look([E + 125, N + 125, 400], 0, -90);
		const away = look([E + 125, N + 125, 400], 0, 90);
		const planner = new Planner();
		const refined = (view: View, now: number) =>
			!planner.plan(tree, view, resident, { ...UNBOUND, now }).cut.includes(root);
		expect(refined(below, 0)).toBe(true);
		expect(refined(away, 1000)).toBe(true);
		expect(refined(away, HOLD)).toBe(true);
		expect(refined(away, HOLD + 1)).toBe(false);
	});

	it('plans the same cut near the camera over a 2 km and a 64 km world', () => {
		const small = around(settle(twoKm(), down, UNBOUND).cut, E + 1100, N + 1100);
		const big = rooted({ level: 8, e: 704000, n: 6144000 });
		const large = around(settle(big, down, UNBOUND).cut, E + 1100, N + 1100);
		expect(small.length).toBeGreaterThan(0);
		expect(large).toEqual(small);
	});

	it('keeps the tree bounded over a 20 km flight that prunes each step', () => {
		const tree = rooted({ level: 8, e: 704000, n: 6144000 });
		const planner = new Planner();
		let resident = new Set<number>();
		const sizes: number[] = [];
		for (let step = 0; step < 40; step++) {
			const view = look([E + 500 * step, N + 1100, 300], 0, -90);
			// each step outlasts HOLD, so what the camera left behind is let go
			const options = { ...UNBOUND, now: step * 2 * HOLD };
			const plan = () => planner.plan(tree, view, (id) => resident.has(id), options);
			let last = plan();
			for (let round = 0; round < 64 && (last.load.length || last.idx.length); round++) {
				for (const page of last.load) resident.add(page.id);
				for (const wanted of last.idx) tree.add(unit(wanted, { count: COUNT }), wanted.path);
				last = plan();
			}
			// the pool keeps only what the plan keeps
			resident = new Set(last.keep);
			tree.prune(resident);
			sizes.push(tree.pages.size);
		}
		expect(Math.max(...sizes.slice(30))).toBeLessThanOrEqual(2 * Math.max(...sizes.slice(0, 10)));
	});
});
