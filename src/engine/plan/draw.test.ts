import { describe, expect, it } from 'vitest';
import { PAGE_SIDE, type Idx, type PageRow } from '../../format/index.ts';
import type { Drawn } from '../types.ts';
import { world } from '../world/test-tree.ts';
import { Tree, type PageNode } from '../world/tree.ts';
import { FADE_CAP, FADE_MS, Fader } from './draw.ts';

const E = 720000;
const N = 6176000;
const BUDGET = 1_000_000;
const OPAQUE = 0xffffffff;
const ALL_OPAQUE = [OPAQUE, OPAQUE, OPAQUE, OPAQUE];
const all = () => true;

/** a root leaf holding page (1, 0, 0) over its g0 children, 400 splats a page, 100 a quadrant */
function family(missing = -1): { parent: PageNode; children: PageNode[] } {
	const rows: PageRow[] = [];
	const add = (g: number, i: number, j: number) => {
		const side = PAGE_SIDE * 2 ** g;
		const box = Float32Array.of(i * side, j * side, 0, (i + 1) * side, (j + 1) * side, 5);
		rows.push({ g, i, j, count: 400, quadrants: [100, 200, 300], box, offset: 0, length: 0 });
	};
	add(1, 0, 0);
	for (let q = 0; q < 4; q++) if (q !== missing) add(0, q & 1, q >> 1);
	const idx: Idx = {
		level: 0,
		e: E,
		n: N,
		pack: '0'.repeat(16),
		packSize: 0,
		col: null,
		rows,
		children: [],
		descendants: []
	};
	const tree = new Tree(world({ level: 0, e: E, n: N }));
	tree.add(idx, 'leaf.idx');
	const [parent] = tree.roots;
	return { parent, children: parent.children.filter((c): c is PageNode => !!c) };
}

const factors = (drawn: Drawn[], page: PageNode) =>
	drawn.find((d) => d.id === page.id)?.factors ?? 0;

/** every quadrant of every child is opaque, drawn by the child or by the parent's quadrant */
function covered(drawn: Drawn[], parent: PageNode, children: PageNode[]): boolean {
	for (let k = 0; k < 4; k++) {
		const over = (factors(drawn, parent) >>> (8 * k)) & 255;
		for (let q = 0; q < 4; q++) {
			const own = (factors(drawn, children[k]) >>> (8 * q)) & 255;
			if (over !== 255 && own !== 255) return false;
		}
	}
	return true;
}

/** a fader that drew the parent alone and has finished fading it in */
function settled(parent: PageNode, budget = BUDGET): Fader {
	const fader = new Fader();
	fader.update([parent], all, 0, budget);
	fader.update([parent], all, FADE_MS, budget);
	return fader;
}

describe('fader', () => {
	it('fades an area without a drawer in from nothing and finishes in FADE_MS', () => {
		const { parent } = family();
		const fader = new Fader();
		let frame = fader.update([parent], all, 0, BUDGET);
		expect(factors(frame.drawn, parent)).toBe(0);
		expect(frame.fading).toBe(true);
		frame = fader.update([parent], all, FADE_MS / 2, BUDGET);
		expect(factors(frame.drawn, parent)).toBe(0x80808080);
		frame = fader.update([parent], all, FADE_MS, BUDGET);
		expect(factors(frame.drawn, parent)).toBe(OPAQUE);
		expect(frame.fading).toBe(false);
	});

	it('never leaves a hole while a refinement and a coarsening fade', () => {
		const { parent, children } = family();
		const fader = settled(parent);
		const refining = [1000, 1100, 1200].map((now) => fader.update(children, all, now, BUDGET));
		for (const step of refining) {
			expect(covered(step.drawn, parent, children)).toBe(true);
			expect(step.fading).toBe(true);
		}
		expect(factors(refining[1].drawn, children[0])).toBe(0x66666666);
		// the parent fades out under its children once their ramps are done
		for (const now of [1000 + FADE_MS, 1100 + FADE_MS]) {
			const step = fader.update(children, all, now, BUDGET);
			expect(children.map((c) => factors(step.drawn, c))).toEqual(ALL_OPAQUE);
			expect(step.fading).toBe(true);
		}
		let frame = fader.update(children, all, 1000 + 2 * FADE_MS, BUDGET);
		expect(frame.fading).toBe(false);
		expect(factors(frame.drawn, parent)).toBe(0);
		expect(children.map((c) => factors(frame.drawn, c))).toEqual(ALL_OPAQUE);

		const coarsening = [2000, 2100, 2200, 2000 + FADE_MS, 2100 + FADE_MS].map((now) =>
			fader.update([parent], all, now, BUDGET)
		);
		for (const step of coarsening) {
			expect(covered(step.drawn, parent, children)).toBe(true);
			expect(step.fading).toBe(true);
		}
		frame = fader.update([parent], all, 2000 + 2 * FADE_MS, BUDGET);
		expect(frame.fading).toBe(false);
		expect(frame.drawn).toEqual([{ id: parent.id, factors: OPAQUE }]);
	});

	it('swaps hard past the cap', () => {
		const { parent, children } = family();
		const fader = new Fader();
		let frame = fader.update([parent], all, 0, 4);
		expect(factors(frame.drawn, parent)).toBe(OPAQUE);
		expect(frame.fading).toBe(false);
		frame = fader.update(children, all, 10, 4);
		expect(factors(frame.drawn, parent)).toBe(0);
		expect(children.map((c) => factors(frame.drawn, c))).toEqual(ALL_OPAQUE);
		expect(frame.fading).toBe(false);
	});

	it('fades what fits under the cap and swaps the rest hard', () => {
		const { parent, children } = family();
		// two children's quadrants and the two parent quadrants under them fill the cap
		const budget = 1000 / FADE_CAP;
		const fader = settled(parent, budget);
		let frame = fader.update(children, all, 1000, budget);
		expect(children.map((c) => factors(frame.drawn, c))).toEqual([0, 0, OPAQUE, OPAQUE]);
		expect(factors(frame.drawn, parent)).toBe(0x0000ffff);
		expect(covered(frame.drawn, parent, children)).toBe(true);
		expect(frame.fading).toBe(true);
		fader.update(children, all, 1000 + FADE_MS, budget);
		frame = fader.update(children, all, 1000 + 2 * FADE_MS, budget);
		expect(children.map((c) => factors(frame.drawn, c))).toEqual(ALL_OPAQUE);
		expect(frame.fading).toBe(false);
	});

	it('swaps hard once the pages a fade holds would take more pool slots than the cap', () => {
		const { parent, children } = family();
		// four children of 400 splats fit the cap as splats, not as pages of 512 slots
		const budget = 2020 / FADE_CAP;
		const fader = new Fader();
		fader.update(children, all, 0, budget);
		const frame = fader.update([parent], all, 1000, budget);
		expect(factors(frame.drawn, parent)).toBe(0xff000000);
		expect(children.map((c) => factors(frame.drawn, c))).toEqual([OPAQUE, OPAQUE, OPAQUE, 0]);
		expect(covered(frame.drawn, parent, children)).toBe(true);
	});

	it('keeps the parent drawing until its children are resident', () => {
		const { parent, children } = family();
		const fader = settled(parent);
		const frame = fader.update(children, (id) => id === parent.id, 1000, BUDGET);
		expect(frame.drawn).toEqual([{ id: parent.id, factors: OPAQUE }]);
		expect(frame.fading).toBe(false);
	});

	it('hides an empty quadrant once its page is refined past it', () => {
		const { parent, children } = family(3);
		const fader = settled(parent);
		let frame = fader.update(children, all, 1000, BUDGET);
		expect(factors(frame.drawn, parent)).toBe(0x00ffffff);
		fader.update(children, all, 1000 + FADE_MS, BUDGET);
		frame = fader.update(children, all, 1000 + 2 * FADE_MS, BUDGET);
		expect(factors(frame.drawn, parent)).toBe(0);
		expect(frame.fading).toBe(false);
	});

	it('fades the parent out under its children over FADE_MS rather than dropping it', () => {
		const { parent, children } = family();
		const fader = settled(parent);
		fader.update(children, all, 1000, BUDGET);
		fader.update(children, all, 1000 + FADE_MS, BUDGET);
		const half = fader.update(children, all, 1000 + 1.5 * FADE_MS, BUDGET);
		expect(factors(half.drawn, parent)).toBe(0x80808080);
		expect(children.map((c) => factors(half.drawn, c))).toEqual(ALL_OPAQUE);
	});
});
