import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { parseIdx, parseWorld, unitKey } from '../../format/index.ts';
import { ground, latticeNodes, synthetic } from '../stream/synthetic.ts';
import { Tree } from '../world/tree.ts';
import { Cut, cutView, unitInfo, type CutView } from './cut.ts';

const BASE = 'synthetic/';
/** copenhagen */
const E = 724000;
const N = 6176000;
/** 50 km west */
const STEPS = 100;
const STRIDE = 500;
const ALTITUDE = 300;
const IDX_PER_STEP = 8;
/** the pool of a 1M budget */
const OPTIONS = { budget: 1_000_000, capacity: 2_500_000 };
const MiB = 2 ** 20;

// the heap is read after a collection, so garbage timing cannot pass for growth
setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

/** a 1920 x 1080 view west, 30 degrees down, at the viewer's fov */
function look(e: number, n: number, h: number): CutView {
	return cutView({ e, n, h, yaw: -90, pitch: -30, fov: 45 }, 1920, 1080, 1);
}

function p95(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(0.95 * (sorted.length - 1))];
}

const early = (values: number[]) => Math.max(...values.slice(20, 40));
const late = (values: number[]) => Math.max(...values.slice(-20));
const mib = (bytes: number) => (bytes / MiB).toFixed(0);

describe('scale', () => {
	it('keeps cut time, tree and heap flat over 50 km', { timeout: 300_000 }, async () => {
		const fetch = synthetic();
		const json = new TextDecoder().decode(await fetch(BASE + 'world.json', null));
		const world = parseWorld(JSON.parse(json));
		const cut = new Cut();
		const tree = new Tree(world, {
			added: (unit, root) => cut.unit(unitInfo(unit, root)),
			pruned: (units) => units.forEach((unit) => cut.drop(unitKey(unit)))
		});
		for (const root of world.roots) {
			tree.add(await parseIdx(await fetch(BASE + root.idx, null)), root.idx);
		}
		let resident = new Set<number>();
		const ms: number[] = [];
		const pages: number[] = [];
		const heap: number[] = [];
		for (let step = 0; step <= STEPS; step++) {
			const e = E - STRIDE * step;
			const view = look(e, N, ground(e, N) + ALTITUDE);
			const start = performance.now();
			const plan = cut.plan({ ...OPTIONS, views: [view] });
			ms.push(performance.now() - start);
			cut.verdict(true);
			// loads land at once and the pool keeps only what the plan reads and wants
			const keep = new Set([...plan.touched, ...plan.load]);
			for (const id of plan.load) {
				const page = tree.pages.get(id)!;
				cut.page(id, latticeNodes(page.unit, page.unit.pages.indexOf(page)));
			}
			for (const id of resident) if (!keep.has(id)) cut.evict(id);
			resident = keep;
			tree.prune(keep);
			// added after the prune, which drops units no plan has read a page of yet
			for (const path of plan.idx.slice(0, IDX_PER_STEP)) {
				tree.add(await parseIdx(await fetch(BASE + path, null)), path);
			}
			pages.push(tree.pages.size);
			gc();
			heap.push(process.memoryUsage().heapUsed);
		}
		const report = [
			`cut p95 ${p95(ms.slice(20, 40)).toFixed(0)} then ${p95(ms.slice(-20)).toFixed(0)} ms`,
			`tree pages ${early(pages)} then ${late(pages)}`,
			`heap ${mib(early(heap))} then ${mib(late(heap))} MiB`
		];
		console.info(`scale over ${STEPS} steps: ${report.join(', ')}`);
		expect(late(pages)).toBeLessThanOrEqual(1.5 * early(pages));
		expect(late(heap)).toBeLessThanOrEqual(1.5 * early(heap));
		// a 1M cut is ~100 ms of a worker on the 4060 host; flat is what this holds, not fast
		expect(p95(ms.slice(-20))).toBeLessThanOrEqual(1.5 * p95(ms.slice(20, 40)));
	});
});
