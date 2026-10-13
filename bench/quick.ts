// frames come from engine.step(), not animation frames, so vsync and window throttling stay out

import {
	createEngine,
	http,
	parsePose,
	viewOf,
	type Engine,
	type Pose,
	type StepReport
} from '../src/index.ts';

export interface Options {
	/** poses as e,n,h,yaw,pitch,dist */
	a: string;
	b: string;
	budget: number;
	viewDistance: number;
	sky: [number, number, number];
	/** synthetic draws a generated world and fetches nothing; page is http as the page's own Fetch */
	source: 'http' | 'synthetic' | 'page';
	/** a remote world.json to stream instead of the served world */
	world?: string;
}

export interface Repetition {
	metrics: Record<string, number>;
	/** why the repetition is invalid, empty when it is valid */
	reasons: string[];
}

const WIDTH = 1920;
const HEIGHT = 1080;
const FRAMES = 40;
const REPETITIONS = 3;
const DRAG_MS = 1200;
const DRAG_DEG = 90;
/** a slow pan either side of a settled view, as a hand resting on the mouse makes; moving the
 * eye, it engages what follows the camera's velocity, which a turn on the spot would not */
const JIGGLE_M = 8;
const SWINGS = 2;
const SWING_MS = 600;
/** compared frames, downscaled */
const SHOT = [480, 270] as const;
/** a longer interval between animation frames is a hitch the eye sees */
const HITCH_MS = 50;
/** a 100 Hz display */
const PACE_MS = 10;
/** a longer gap between measured frames invalidates the run */
const GAP_MS = 100;
const IDLE_MS = 60_000;
const MIB = 2 ** 20;

const canvas = document.querySelector('canvas')!;
const shot = new OffscreenCanvas(...SHOT).getContext('2d', { willReadFrequently: true })!;
let engine: Engine;
let a: Pose;
let b: Pose;
let lost = '';

function pose(cam: string): Pose {
	const p = parsePose(cam);
	if (!p) throw new Error(`bad pose ${cam}`);
	return p;
}

const look = (p: Pose) => engine.setCamera(viewOf(p));

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

/** nearest rank */
function percentile(values: number[], q: number) {
	const sorted = values.toSorted((x, y) => x - y);
	return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

// manual mode draws nothing on its own, so frames are stepped until idle resolves
async function settle() {
	const start = performance.now();
	let idle = false;
	engine.idle().then(() => (idle = true));
	while (!idle) {
		if (performance.now() - start > IDLE_MS) {
			throw new Error(`not idle after ${IDLE_MS} ms: ${JSON.stringify(engine.stats())}`);
		}
		await engine.step();
	}
}

/** steps frames until the splats the plan shows are resident; the first frame plans for a resting camera */
async function detailed() {
	const start = performance.now();
	do {
		if (performance.now() - start > IDLE_MS) {
			throw new Error(`no detail after ${IDLE_MS} ms: ${JSON.stringify(engine.stats())}`);
		}
		await engine.step();
	} while (engine.stats().missing > 0);
}

async function ready(options: Options) {
	a = pose(options.a);
	b = pose(options.b);
	engine = await createEngine(canvas, {
		settings: { budget: options.budget, viewDistance: options.viewDistance },
		sky: options.sky,
		cache: 'memory',
		source: options.source === 'page' ? http : options.source,
		manual: true
	});
	engine.resize(WIDTH, HEIGHT, 1);
	engine.onLost((reason) => (lost = reason));
	const start = performance.now();
	await engine.open(options.world ?? `${location.origin}/world/world.json`);
	look(a);
	await settle();
	const idleMs = performance.now() - start;
	const info = (await navigator.gpu.requestAdapter())?.info;
	const adapter = info ? info.description || `${info.vendor} ${info.architecture}` : 'none';
	return { idleMs, adapter };
}

type Measured = Awaited<ReturnType<typeof frames>>;

async function frames() {
	const ms: number[] = [];
	const reports: StepReport[] = [];
	// two frames in flight, as a browser pipelines animation frames
	let pending = engine.step();
	let last = performance.now();
	for (let i = 0; i < FRAMES; i++) {
		const next = engine.step();
		reports.push(await pending);
		const now = performance.now();
		ms.push(now - last);
		last = now;
		pending = next;
	}
	await pending;
	return { ms, reports, stats: engine.stats() };
}

/** frames paced like a PACE_MS display, the camera put at(ms since start) before each; step() draws
 * them, since a window the desktop covers gets no animation frames */
async function animate(ms: number, at: (t: number) => Pose, each = () => {}) {
	const gaps: number[] = [];
	const start = performance.now();
	let last = start;
	let pending = engine.step();
	for (let k = 1; last - start < ms; k++) {
		look(at(last - start));
		each();
		const next = engine.step();
		await pending;
		const now = performance.now();
		gaps.push(now - last);
		last = now;
		pending = next;
		const wait = start + k * PACE_MS - performance.now();
		if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
	}
	await pending;
	return gaps;
}

async function run(): Promise<Repetition[]> {
	const byPose: Measured[][] = [];
	for (const p of [a, b]) {
		look(p);
		await settle();
		const repetitions = [];
		for (let i = 0; i < REPETITIONS; i++) repetitions.push(await frames());
		byPose.push(repetitions);
	}
	return byPose[0].map((first, i) => repetition([first, byPose[1][i]]));
}

function repetition(poses: Measured[]): Repetition {
	const ms = poses.flatMap((p) => p.ms);
	const reports = poses.flatMap((p) => p.reports);
	const stats = poses.map((p) => p.stats);
	// completions of pipelined frames arrive in pairs, so percentiles read pairs of frames
	const paired = poses.flatMap((p) => p.ms.slice(1).map((v, i) => (v + p.ms[i]) / 2));
	const median = percentile(paired, 0.5);
	const metrics: Record<string, number> = {
		fps: 1000 / mean(ms),
		frameP50Ms: median,
		frameP95Ms: percentile(paired, 0.95),
		frameP99Ms: percentile(paired, 0.99),
		stutters: paired.filter((v) => v > 2 * median).length,
		gpuMs: mean(reports.map((r) => r.gpuMs)),
		cpuMs: mean(reports.map((r) => r.cpuMs)),
		drawn: mean(stats.map((s) => s.drawn)),
		planned: mean(stats.map((s) => s.planned)),
		pagesResident: mean(stats.map((s) => s.pages.resident)),
		poolMiB: mean(stats.map((s) => s.memory.pool)) / MIB,
		buffersMiB: mean(stats.map((s) => s.memory.buffers)) / MIB
	};
	for (const name of new Set(reports.flatMap((r) => Object.keys(r.passes)))) {
		metrics[`gpu.${name}Ms`] = mean(reports.map((r) => r.passes[name] ?? 0));
	}
	const reasons: string[] = [];
	const gap = Math.max(...ms);
	if (gap > GAP_MS) reasons.push(`a frame took ${gap.toFixed(0)} ms`);
	if (lost) reasons.push(`device lost: ${lost}`);
	return { metrics, reasons };
}

/** the canvas, read in the task that drew it, since chrome lets go of a shown frame's texture */
function capture(): Uint8ClampedArray {
	shot.drawImage(canvas, 0, 0, ...SHOT);
	return shot.getImageData(0, 0, ...SHOT).data;
}

/** a frame and its picture */
async function snap(): Promise<Uint8ClampedArray> {
	const pending = engine.step();
	const picture = capture();
	await pending;
	return picture;
}

/** mean absolute rgb difference, 0..255 */
function difference(x: Uint8ClampedArray, y: Uint8ClampedArray): number {
	let sum = 0;
	for (let i = 0; i < x.length; i += 4) {
		sum += Math.abs(x[i] - y[i]) + Math.abs(x[i + 1] - y[i + 1]) + Math.abs(x[i + 2] - y[i + 2]);
	}
	return sum / ((x.length / 4) * 3);
}

/** once a run at the settled b: a resting hand's jiggle, then a drag that streams */
async function move(): Promise<Repetition> {
	const still = await snap();
	const noise = difference(still, await snap());
	// each swing passes back through b mid-motion, so that frame shows what moving costs the view
	const jiggle: number[] = [];
	const diffs: number[] = [];
	for (let k = 0; k < SWINGS; k++) {
		const sway = (t: number) => ({
			...b,
			e: b.e + JIGGLE_M * Math.sin((2 * Math.PI * t) / SWING_MS)
		});
		jiggle.push(...(await animate(SWING_MS, sway)));
		// back at b, the reading stalls this frame, so it stays out of the timings
		look(b);
		diffs.push(difference(still, await snap()));
	}
	// the share of the detail on screen that has not arrived yet
	const missing: number[] = [];
	const behind = () => {
		const { planned, missing: left } = engine.stats();
		missing.push(left / Math.max(1, planned));
	};
	performance.mark('drag:start');
	const yaw = (t: number) => ({ ...b, yaw: b.yaw + (DRAG_DEG * t) / DRAG_MS });
	const drag = await animate(DRAG_MS, yaw, behind);
	performance.mark('drag:end');
	// how long the view stays short of its detail once the camera stops; fades come on top
	const stopped = performance.now();
	await detailed();
	const settleMs = performance.now() - stopped;
	await settle();
	const hitches = (gaps: number[]) => gaps.filter((g) => g > HITCH_MS).length;
	const metrics: Record<string, number> = {
		stillDiff: noise,
		jiggleDiff: mean(diffs),
		jiggleMaxMs: Math.max(...jiggle),
		jiggleHitches: hitches(jiggle),
		dragFps: 1000 / mean(drag),
		dragP95Ms: percentile(drag, 0.95),
		dragMaxMs: Math.max(...drag),
		dragHitches: hitches(drag),
		dragMissing: mean(missing),
		settleMs
	};
	const reasons: string[] = [];
	if (lost) reasons.push(`device lost: ${lost}`);
	return { metrics, reasons };
}

Object.assign(window, { bench: { ready, run, move } });
