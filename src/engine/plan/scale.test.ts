import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parseIdx, parseWorld } from '../../format/index.ts';
import { view as viewMatrix } from '../math/mat4.ts';
import { ground, synthetic } from '../stream/synthetic.ts';
import { Tree } from '../world/tree.ts';
import { HOLD, Planner, type View } from './cut.ts';

const BASE = 'synthetic/';
/** copenhagen */
const E = 724000;
const N = 6176000;
/** 50 km west */
const STEPS = 100;
const STRIDE = 500;
const ALTITUDE = 300;
const IDX_PER_STEP = 8;
const OPTIONS = { budget: 4_000_000, capacity: 10_000_000 };
const rad = Math.PI / 180;
const MiB = 2 ** 20;

// the heap is read after a collection, so garbage timing cannot pass for growth
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/** a 1920 x 1080 view west, 30 degrees down, at the viewer's fov and default reach */
function look(e: number, n: number, h: number): View {
	const origin = [Math.round(e), Math.round(n), 0] as const;
	const eye = [e - origin[0], n - origin[1], h] as const;
	return {
		origin,
		view: viewMatrix(new Float64Array(16), eye, -90 * rad, -30 * rad),
		width: 1920,
		height: 1080,
		tan: Math.tan(22.5 * rad),
		near: 0.5,
		far: 1500
	};
}

function p95(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(0.95 * (sorted.length - 1))];
}

const early = (values: number[]) => Math.max(...values.slice(20, 40));
const late = (values: number[]) => Math.max(...values.slice(-20));
const mib = (bytes: number) => (bytes / MiB).toFixed(0);

describe('scale', () => {
	it('keeps planner time, tree and heap flat over 50 km', { timeout: 120_000 }, async () => {
		const fetch = synthetic();
		const json = new TextDecoder().decode(await fetch(BASE + 'world.json', null));
		const tree = new Tree(parseWorld(JSON.parse(json)));
		for (const root of tree.world.roots) {
			tree.add(await parseIdx(await fetch(BASE + root.idx, null)), root.idx);
		}
		const planner = new Planner();
		let resident = new Set<number>();
		const ms: number[] = [];
		const pages: number[] = [];
		const heap: number[] = [];
		for (let step = 0; step <= STEPS; step++) {
			const e = E - STRIDE * step;
			const view = look(e, N, ground(e, N) + ALTITUDE);
			const options = { ...OPTIONS, now: step * 2 * HOLD };
			const start = performance.now();
			const plan = planner.plan(tree, view, (id) => resident.has(id), options);
			ms.push(performance.now() - start);
			// loads land at once and the pool keeps only what the plan keeps
			resident = new Set(plan.keep);
			tree.prune(plan.keep);
			// added after the prune, which drops units no plan has kept a page of yet
			for (const wanted of plan.idx.slice(0, IDX_PER_STEP)) {
				tree.add(await parseIdx(await fetch(BASE + wanted.path, null)), wanted.path);
			}
			pages.push(tree.pages.size);
			gc();
			heap.push(process.memoryUsage().heapUsed);
		}
		const report = [
			`planner p95 ${p95(ms).toFixed(2)} ms`,
			`tree pages ${early(pages)} then ${late(pages)}`,
			`heap ${mib(early(heap))} then ${mib(late(heap))} MiB`
		];
		console.info(`scale over ${STEPS} steps: ${report.join(', ')}`);
		expect(late(pages)).toBeLessThanOrEqual(1.5 * early(pages));
		expect(late(heap)).toBeLessThanOrEqual(1.5 * early(heap));
		expect(p95(ms)).toBeLessThan(10);
	});
});
