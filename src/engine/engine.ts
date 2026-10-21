// the engine: world, planner, stream, pool and renderer behind one small api

import {
	CLUSTER,
	GEOMETRY_WORDS,
	directory,
	parseWorld,
	type DecodedPage,
	type World
} from '../format/index.ts';
import { PROJECTED_WORDS } from './gpu/layout.ts';
import { requestGpu, type Gpu } from './gpu/device.ts';
import { Pool } from './gpu/pool.ts';
import { Renderer, type DepthPick, type HeightsRequest } from './gpu/renderer.ts';
import { planes } from './math/frustum.ts';
import {
	invert,
	multiply,
	perspective,
	transform,
	view as viewMatrix,
	type Mat4
} from './math/mat4.ts';
import { CAP, type CutResult, type CutView } from './plan/cut.ts';
import { Planner } from './plan/planner.ts';
import type { Fetch } from '../ports.ts';
import type { Frame, Host, Plugin, Post, Shade } from './plugin.ts';
import { percentile, pixelRatio, Quality } from './quality.ts';
import { Feed, type Wants } from './stream/feed.ts';
import { http } from '../adapters/http.ts';
import { Loader } from './stream/loader.ts';
import type { Camera, Drawn, Settings, Stats } from './types.ts';
import { Tree, type PageNode } from './world/tree.ts';

export interface EngineOptions {
	settings: Settings;
	/** display rgb 0..1 behind the splats */
	sky: readonly [number, number, number];
	cache?: 'opfs' | 'memory' | 'none';
	/**
	 * where the bytes come from: http, the generated world of the benches, or the page's own Fetch,
	 * which runs on the main thread
	 */
	source?: 'http' | 'synthetic' | Fetch;
	/** no animation loop: frames come only from step(), for benches */
	manual?: boolean;
}

export interface StepReport {
	/** main-thread ms of the frame */
	cpuMs: number;
	/** 0 without timestamps */
	gpuMs: number;
	passes: Record<string, number>;
}

export interface Engine {
	open(worldUrl: string): Promise<World>;
	setCamera(camera: Camera): void;
	configure(settings: Partial<Settings>): void;
	/** canvas size in css pixels and the device pixel ratio to render at */
	resize(width: number, height: number, ratio: number): void;
	/** world point under canvas css pixel (x, y), or null over nothing */
	pick(x: number, y: number): Promise<[number, number, number] | null>;
	ground(e: number, n: number): number | undefined;
	/** ground(e, n) once every .idx over (e, n) is read */
	groundAt(e: number, n: number): Promise<number | undefined>;
	/**
	 * tops, as world heights, of the solid splats the next frame draws over cells x cells of 1 m from the
	 * south-west corner (west, south), rows south to north, NaN where none; null if no frame comes
	 */
	heights(west: number, south: number, cells: number): Promise<Float32Array | null>;
	stats(): Stats;
	/** resolves once nothing plans or loads and the cut misses nothing */
	idle(): Promise<void>;
	use(plugin: Plugin): () => void;
	/** device loss, with its reason; the engine is then dead */
	onLost(fn: (reason: string) => void): () => void;
	/** fn(now) starts each frame the loop draws, so a camera it sets shows in that frame */
	onFrame(fn: (now: number) => void): () => void;
	/** the camera may soon move: after a rest, frames run a moment so the gpu is up to speed by then */
	warm(): void;
	requestFrame(): void;
	/** one frame now, after the plan it awaits; resolved when the gpu finished it */
	step(): Promise<StepReport>;
	destroy(): void;
}

/** thrown by createEngine when the browser offers no webgpu */
export class NoWebGpu extends Error {
	constructor() {
		super('This viewer needs WebGPU. Update to the latest Chrome, Edge, Safari or Firefox.');
		this.name = 'NoWebGpu';
	}
}

export async function createEngine(
	canvas: HTMLCanvasElement,
	options: EngineOptions
): Promise<Engine> {
	const gpu = await requestGpu();
	if (!gpu) throw new NoWebGpu();
	const context = canvas.getContext('webgpu');
	if (!context) {
		gpu.device.destroy();
		throw new NoWebGpu();
	}
	context.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' });
	// persisted storage keeps the page cache out of the browser's eviction; best effort
	if ((options.cache ?? 'opfs') === 'opfs') void navigator.storage?.persist().catch(() => false);
	// only benches draw the synthetic world, so its generator stays out of the viewer's bundle
	const { source = 'http' } = options;
	const fetch =
		source === 'synthetic'
			? (await import('./stream/synthetic.ts')).synthetic()
			: source === 'http'
				? http
				: source;
	return new GpuEngine(canvas, gpu, context, options, fetch);
}

const NEAR = 0.2;
/** bytes of queued pages one frame may upload */
const UPLOAD_BYTES = 24 * 1024 * 1024;
/** splats the pool holds, per splat of budget */
const POOL_SHARE = 2.5;
/** splats one frame may project, per splat of budget: the most a cut draws */
const FRAME_SHARE = CAP;
/** metres: the floating origin's grid, and how far the camera may stray from it */
const GRID = 1024;
const REBASE = 2048;
/** frames the gpu may still be working on; chrome itself queues any number, latency growing without bound */
const IN_FLIGHT = 2;
/** ms the planner looks ahead along the camera's velocity */
const AHEAD_MS = 300;
/** ms the camera velocity averages over */
const VELOCITY_MS = 100;
/** ms between frames, or camera moves, that still make one run */
const GAP_MS = 250;
/** ms the camera rests before the full render scale returns */
const STILL_MS = 300;
/** ms without frames after which the gpu has clocked down, its next frames many times slower */
const COLD_MS = 1000;
/** ms of frames that clock it back up */
const WARM_MS = 400;
/** ms before a failed reopen tries again */
const REOPEN_MS = 5000;
/** animated frames the timing medians cover */
const SAMPLES = 60;
const DEG = Math.PI / 180;
const DESTROYED = 'The viewer was closed.';
const SUPERSEDED = 'Another world was opened.';

type Point = readonly [number, number, number];

/** pool and frame capacities in splats for a budget, every binding within the device limits */
export function capacities(
	budget: number,
	limits: Pick<GPUSupportedLimits, 'maxStorageBufferBindingSize' | 'maxBufferSize'>
): { pool: number; frame: number } {
	const most = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
	const fit = (share: number, bytes: number) => {
		const wanted = Math.ceil((budget * share) / CLUSTER) * CLUSTER;
		return Math.min(wanted, Math.floor(most / bytes / CLUSTER) * CLUSTER);
	};
	// the widest binding of each: pool geometry, projected splats
	return {
		pool: fit(POOL_SHARE, GEOMETRY_WORDS * 4),
		frame: fit(FRAME_SHARE, PROJECTED_WORDS * 4)
	};
}

/** origin while position stays within REBASE of it, else the GRID point nearest position */
export function rebase(origin: Point, position: Point): Point {
	const [e, n, h] = position;
	if (Math.hypot(e - origin[0], n - origin[1], h - origin[2]) <= REBASE) return origin;
	const snap = (x: number) => Math.round(x / GRID) * GRID;
	return [snap(e), snap(n), snap(h)];
}

/**
 * the world point at view depth under target pixel (x, y) from the top-left, for a frame's proj
 * and view in the floating-origin frame at origin
 */
export function unproject(
	pixel: readonly [number, number],
	size: readonly [number, number],
	depth: number,
	proj: Mat4,
	view: Mat4,
	origin: Point
): [number, number, number] {
	const x = (2 * pixel[0]) / size[0] - 1;
	const y = 1 - (2 * pixel[1]) / size[1];
	const inView: Point = [(depth * x) / proj[0], (depth * y) / proj[5], -depth];
	const [e, n, h] = transform(invert(new Float64Array(16), view)!, inView);
	return [e + origin[0], n + origin[1], h + origin[2]];
}

function relative(c: Camera, origin: Point): Point {
	return [c.e - origin[0], c.n - origin[1], c.h - origin[2]];
}

function push(samples: number[], value: number): void {
	samples.push(value);
	if (samples.length > SAMPLES) samples.shift();
}

interface Installed<T> {
	hook: T;
	off: () => void;
}

interface Picking {
	/** target pixels */
	x: number;
	y: number;
	resolve: (point: [number, number, number] | null) => void;
}

interface Measuring {
	west: number;
	south: number;
	cells: number;
	resolve: (tops: Float32Array | null) => void;
}

class GpuEngine implements Engine {
	#canvas: HTMLCanvasElement;
	#gpu: Gpu;
	#context: GPUCanvasContext;
	#options: EngineOptions;
	#fetch: Fetch;
	#settings: Settings;
	#quality: Quality;
	#pool: Pool;
	#renderer: Renderer;
	/** splats one frame may project */
	#frameCapacity: number;
	#planner = new Planner();

	#url: string | null = null;
	#tree: Tree | null = null;
	#loader: Loader | null = null;
	#feed: Feed | null = null;
	#opening = 0;
	#reopening = false;

	#camera: Camera = { e: 0, n: 0, h: 0, yaw: 0, pitch: 0, fov: 45 };
	#cameraAt = -Infinity;
	/** metres per ms, smoothed */
	#velocity = [0, 0, 0];
	#origin: Point = [0, 0, 0];
	#view = new Float64Array(16);
	#proj = new Float64Array(16);
	#turn = new Float64Array(16);
	#viewProj = new Float64Array(16);
	#planes = new Float32Array(24);
	/** canvas css size and the device pixel ratio */
	#css: [number, number, number];
	/** render target pixels */
	#target: [number, number];

	#raf = 0;
	#inFlight = 0;
	/** a frame was asked for while IN_FLIGHT were queued */
	#behind = false;
	/** the plan the pool draws, and what it asks of the stream */
	#plan: CutResult | null = null;
	#wants: Wants | null = null;
	/** a plan back from the worker and not yet applied */
	#ready: CutResult | null = null;
	/** the plan in flight, at most one */
	#planning: Promise<void> | null = null;
	/** whether the pool took the last plan, which the worker tells its next one's changes by */
	#applied = true;
	/** uploaded pages the pool let go of since the plan in flight was asked for */
	#evicted = new Set<number>();
	#moved = true;
	/** the camera moved since the last plan was asked for, which then looks ahead */
	#moving = false;
	/** something a plan reads changed: the camera, the size, the budget, a page or an .idx */
	#stale = true;
	/** the last plan looked ahead of a moving camera; the first frame it rests plans again */
	#heading = false;
	#lastFrame = -Infinity;
	#warmUntil = -Infinity;
	#movedAt = -Infinity;
	#frameMs: number[] = [];
	#cpuMs: number[] = [];

	#shades: Installed<Shade>[] = [];
	#posts: Installed<Post>[] = [];
	#picks: Picking[] = [];
	#measures: Measuring[] = [];
	#idlers: (() => void)[] = [];
	#lostListeners = new Set<(reason: string) => void>();
	#frameListeners = new Set<(now: number) => void>();
	/** frame listeners run; a camera they set needs no frame of its own */
	#starting = false;
	#destroyed = false;
	#lost = false;

	constructor(
		canvas: HTMLCanvasElement,
		gpu: Gpu,
		context: GPUCanvasContext,
		options: EngineOptions,
		fetch: Fetch
	) {
		this.#canvas = canvas;
		this.#gpu = gpu;
		this.#context = context;
		this.#options = options;
		this.#fetch = fetch;
		this.#settings = { ...options.settings };
		this.#quality = this.#control();
		this.#css = [canvas.width, canvas.height, 1];
		this.#target = [Math.max(1, canvas.width), Math.max(1, canvas.height)];
		const { pool, frame } = capacities(this.#budget, gpu.device.limits);
		this.#pool = new Pool(gpu.device, pool);
		this.#renderer = new Renderer(gpu, context, this.#pool, frame);
		this.#frameCapacity = frame;
		void gpu.device.lost.then((info) => {
			if (this.#destroyed) return;
			this.#lost = true;
			cancelAnimationFrame(this.#raf);
			for (const fn of this.#lostListeners) fn(info.message || info.reason);
		});
	}

	async open(worldUrl: string): Promise<World> {
		if (this.#destroyed) throw new Error(DESTROYED);
		const ticket = ++this.#opening;
		const check = () => {
			if (this.#destroyed) throw new Error(DESTROYED);
			if (ticket !== this.#opening) throw new Error(SUPERSEDED);
		};
		const { cache = 'opfs', source = 'http' } = this.#options;
		// a worker resolves a relative url against its own script, not the page
		if (source === 'http') worldUrl = new URL(worldUrl, document.baseURI).href;
		const bytes = await this.#fetch(worldUrl, null);
		const world = parseWorld(JSON.parse(new TextDecoder().decode(bytes)));
		check();
		const loader = new Loader({
			base: directory(worldUrl),
			workers: Math.min(6, Math.max(2, navigator.hardwareConcurrency - 2)),
			cache,
			source
		});
		let roots;
		try {
			roots = await Promise.all(world.roots.map((root) => loader.idx(root.idx)));
			check();
		} catch (error) {
			loader.destroy();
			throw error;
		}

		this.#feed?.destroy();
		this.#feed = null;
		this.#loader?.destroy();
		// page ids restart with the tree, so the old world's pages leave the pool and the planner
		this.#pool.clear();
		this.#pool.gone();
		const planner = this.#planner;
		planner.reset();
		const tree = new Tree(world, {
			added: (unit, root) => planner.unit(unit, root),
			pruned: (units) => planner.drop(units)
		});
		roots.forEach((idx, k) => tree.add(idx, world.roots[k].idx));
		this.#url = worldUrl;
		this.#tree = tree;
		this.#loader = loader;
		this.#plan = null;
		this.#wants = null;
		this.#ready = null;
		this.#planning = null;
		this.#applied = true;
		this.#evicted.clear();
		this.#feed = this.#feedFor(tree, loader);
		this.#stale = true;
		this.requestFrame();
		return world;
	}

	setCamera(camera: Camera): void {
		if (this.#destroyed) return;
		const now = performance.now();
		const dt = now - this.#cameraAt;
		const last = this.#camera;
		const v = this.#velocity;
		if (dt > GAP_MS) v.fill(0);
		else if (dt > 0) {
			const a = 1 - Math.exp(-dt / VELOCITY_MS);
			v[0] += a * ((camera.e - last.e) / dt - v[0]);
			v[1] += a * ((camera.n - last.n) / dt - v[1]);
			v[2] += a * ((camera.h - last.h) / dt - v[2]);
		}
		this.#cameraAt = now;
		this.#camera = { ...camera };
		this.#moved = true;
		this.#moving = true;
		this.#stale = true;
		if (!this.#starting) this.requestFrame();
	}

	configure(settings: Partial<Settings>): void {
		if (this.#destroyed) return;
		const { budget, budgetRange } = this.#settings;
		this.#settings = { ...this.#settings, ...settings };
		const next = this.#settings;
		const same = (a?: readonly number[], b?: readonly number[]) => a?.join() === b?.join();
		// settings handed over unchanged keep the adapted budget
		if (next.budget !== budget || !same(next.budgetRange, budgetRange)) {
			this.#quality = this.#control();
			this.#fit();
		}
		this.#rebudget();
	}

	resize(width: number, height: number, ratio: number): void {
		if (this.#destroyed) return;
		this.#css = [width, height, ratio];
		this.#fit();
	}

	pick(x: number, y: number): Promise<[number, number, number] | null> {
		if (this.#destroyed || this.#lost) return Promise.resolve(null);
		const [width, height] = this.#target;
		const [cssWidth, cssHeight] = this.#css;
		const tx = (x * width) / Math.max(1, cssWidth);
		const ty = (y * height) / Math.max(1, cssHeight);
		return new Promise((resolve) => {
			this.#picks.push({ x: tx, y: ty, resolve });
			this.requestFrame();
		});
	}

	ground(e: number, n: number): number | undefined {
		return this.#tree?.ground(e, n);
	}

	async groundAt(e: number, n: number): Promise<number | undefined> {
		const tree = this.#tree;
		const loader = this.#loader;
		if (!tree || !loader) return undefined;
		await tree.load(e, n, (path) => loader.idx(path));
		this.#stale = true;
		this.requestFrame();
		return tree.ground(e, n);
	}

	heights(west: number, south: number, cells: number): Promise<Float32Array | null> {
		if (this.#destroyed || this.#lost) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.#measures.push({ west, south, cells, resolve });
			this.requestFrame();
		});
	}

	stats(): Stats {
		const pool = this.#pool;
		const feed = this.#feed;
		const gpu = this.#renderer.stats();
		return {
			frameMs: percentile(this.#frameMs, 0.5),
			cpuMs: percentile(this.#cpuMs, 0.5),
			gpuMs: gpu.gpuMs,
			passes: gpu.passes,
			drawn: gpu.drawn,
			planned: this.#plan?.planned ?? 0,
			missing: this.#plan?.missing ?? 0,
			detail: this.#plan?.detail ?? 0,
			projected: this.#plan?.projected ?? 0,
			planMs: this.#plan?.ms ?? 0,
			pages: {
				resident: Array.from(pool.ids()).length,
				drawn: pool.drawn,
				loading: feed?.loading ?? 0,
				queued: feed?.queued ?? 0
			},
			memory: { pool: pool.bytes, buffers: gpu.bytes },
			capacity: pool.capacity,
			budget: this.#budget,
			scale: this.#quality.scale,
			loading: feed !== null && !feed.idle
		};
	}

	idle(): Promise<void> {
		if (this.#destroyed) return Promise.resolve();
		return new Promise((resolve) => {
			this.#idlers.push(resolve);
			this.requestFrame();
		});
	}

	use(plugin: Plugin): () => void {
		if (this.#destroyed) return () => {};
		const host: Host = {
			shade: (hook) => this.#install(this.#shades, hook, this.#renderer.shade(hook)),
			post: (pass) => this.#install(this.#posts, pass, this.#renderer.post(pass))
		};
		const uninstall = plugin(host);
		return () => {
			if (!this.#destroyed) uninstall();
		};
	}

	warm(): void {
		const now = performance.now();
		if (now - this.#lastFrame < COLD_MS) return;
		this.#warmUntil = now + WARM_MS;
		this.requestFrame();
	}

	onFrame(fn: (now: number) => void): () => void {
		this.#frameListeners.add(fn);
		return () => this.#frameListeners.delete(fn);
	}

	onLost(fn: (reason: string) => void): () => void {
		this.#lostListeners.add(fn);
		return () => this.#lostListeners.delete(fn);
	}

	requestFrame(): void {
		if (this.#destroyed || this.#lost || this.#options.manual || this.#raf) return;
		this.#raf = requestAnimationFrame(this.#tick);
	}

	async step(): Promise<StepReport> {
		if (this.#destroyed || this.#lost) return { cpuMs: 0, gpuMs: 0, passes: {} };
		// the plan this frame applies, so a run steps the same every time
		this.#request();
		await this.#planning;
		const { done, cpuMs } = this.#frame(false);
		await done;
		const { gpuMs, passes } = this.#renderer.stats();
		return { cpuMs, gpuMs, passes };
	}

	destroy(): void {
		if (this.#destroyed) return;
		this.#destroyed = true;
		cancelAnimationFrame(this.#raf);
		this.#feed?.destroy();
		this.#loader?.destroy();
		this.#planner.destroy();
		this.#renderer.destroy();
		this.#pool.destroy();
		for (const { resolve } of this.#picks.splice(0)) resolve(null);
		for (const { resolve } of this.#measures.splice(0)) resolve(null);
		for (const resolve of this.#idlers.splice(0)) resolve();
		this.#gpu.device.destroy();
	}

	get #budget(): number {
		return this.#quality.budget;
	}

	/** the frame rate controller for the settings, its budgets within what one frame can project here */
	#control(): Quality {
		const { budget, budgetRange = [budget, budget] } = this.#settings;
		const most = Math.floor(capacities(Infinity, this.#gpu.device.limits).frame / FRAME_SHARE);
		const fit = (splats: number) => Math.max(1, Math.min(splats, most));
		return new Quality(fit(budget), [fit(budgetRange[0]), fit(budgetRange[1])]);
	}

	/** buffers that hold the budget, and a plan for it */
	#rebudget(): void {
		const { pool, frame } = capacities(this.#budget, this.#gpu.device.limits);
		if (pool > this.#pool.capacity || frame > this.#frameCapacity) this.#grow(pool, frame);
		this.#stale = true;
		this.requestFrame();
	}

	/** a larger pool with its pages in place, and a renderer over it */
	#grow(capacity: number, frame: number): void {
		this.#pool.grow(capacity);
		this.#renderer.destroy();
		const renderer = new Renderer(this.#gpu, this.#context, this.#pool, frame);
		renderer.resize(...this.#target);
		for (const entry of this.#shades) entry.off = renderer.shade(entry.hook);
		for (const entry of this.#posts) entry.off = renderer.post(entry.hook);
		this.#renderer = renderer;
		this.#frameCapacity = frame;
	}

	#feedFor(tree: Tree, loader: Loader): Feed {
		const arrive = () => {
			this.#stale = true;
			this.requestFrame();
		};
		return new Feed(tree, loader, this.#pool, arrive, this.#reopen);
	}

	/** a release replaced the world: open its world.json again at the same camera */
	#reopen = (): void => {
		const url = this.#url;
		const tree = this.#tree;
		if (this.#reopening || this.#destroyed || url === null) return;
		this.#reopening = true;
		const retry = () => {
			this.#reopening = false;
			if (this.#tree === tree) setTimeout(this.#reopen, REOPEN_MS);
		};
		void this.open(url).then(() => (this.#reopening = false), retry);
	};

	#install<T>(list: Installed<T>[], hook: T, off: () => void): () => void {
		const entry = { hook, off };
		list.push(entry);
		this.requestFrame();
		return () => {
			const k = list.indexOf(entry);
			if (this.#destroyed || k < 0) return;
			list.splice(k, 1);
			entry.off();
			this.requestFrame();
		};
	}

	/** the render target for the css size, the pixel ratio and the quality scale */
	#fit(): void {
		const [w, h, ratio] = this.#css;
		const r = pixelRatio(w, h, ratio, this.#quality.scale);
		const width = Math.max(1, Math.round(w * r));
		const height = Math.max(1, Math.round(h * r));
		if (width === this.#target[0] && height === this.#target[1]) return;
		this.#target = [width, height];
		this.#canvas.width = width;
		this.#canvas.height = height;
		this.#renderer.resize(width, height);
		this.#stale = true;
		this.requestFrame();
	}

	#tick = (now: number): void => {
		this.#raf = 0;
		if (this.#destroyed || this.#lost) return;
		if (this.#inFlight >= IN_FLIGHT) {
			this.#behind = true;
			return;
		}
		this.#starting = true;
		for (const fn of this.#frameListeners) fn(now);
		this.#starting = false;
		this.#inFlight++;
		void this.#frame(true).done.finally(() => {
			this.#inFlight--;
			if (!this.#behind) return;
			this.#behind = false;
			this.requestFrame();
		});
	};

	#frame(animated: boolean): { done: Promise<void>; cpuMs: number } {
		const now = performance.now();
		const quality = this.#quality;
		const pool = this.#pool;
		const camera = this.#camera;
		const [width, height] = this.#target;
		const far = this.#settings.viewDistance;
		const moved = this.#moved;
		this.#moved = false;

		// floating origin and matrices
		const origin = rebase(this.#origin, [camera.e, camera.n, camera.h]);
		if (origin !== this.#origin) {
			this.#origin = origin;
			pool.setOrigin(origin);
		}
		const eye = relative(camera, origin);
		viewMatrix(this.#view, eye, camera.yaw * DEG, camera.pitch * DEG);
		perspective(this.#proj, camera.fov * DEG, width / height, NEAR, far);
		const frame: Frame = {
			time: now,
			width,
			height,
			view: new Float32Array(this.#view),
			proj: new Float32Array(this.#proj),
			near: NEAR,
			far,
			camera: Float32Array.from(eye),
			origin
		};
		planes(this.#planes, multiply(this.#viewProj, frame.proj, frame.view));

		// plan, stream and upload
		const feed = this.#feed;
		const changes = this.#apply();
		if (feed && this.#wants) feed.update(this.#wants, now);
		const uploaded = (id: number, page: DecodedPage) => this.#planner.page(id, page.nodes);
		if (pool.upload(UPLOAD_BYTES, uploaded) > 0) this.#stale = true;
		if (!this.#options.manual) this.#request();
		pool.draw(changes);
		const picks = this.#picks.splice(0).map((picking) => this.#pick(picking, frame));
		const heights = this.#measures.splice(0).map((measuring) => this.#measure(measuring, origin));
		const done = this.#renderer.render(frame, this.#planes, this.#options.sky, picks, heights);
		const cpuMs = performance.now() - now;

		// what comes next
		const plan = this.#plan;
		const quiet =
			!this.#stale &&
			!this.#heading &&
			!this.#planning &&
			!this.#ready &&
			pool.queued === 0 &&
			(!feed || feed.idle) &&
			(!plan || (plan.load.length === 0 && plan.idx.length === 0 && plan.missing === 0));
		if (quiet && this.#idlers.length) {
			const idlers = this.#idlers.splice(0);
			void done.then(() => idlers.forEach((resolve) => resolve()));
		}
		if (animated) this.#sample(now, cpuMs, moved);
		// the feed and the planner call for frames as they change things, so loads and plans in flight need none
		const warming = now < this.#warmUntil;
		const pending = pool.queued > 0 || ((this.#stale || this.#heading) && !this.#planning);
		if (pending || quality.scale < 1 || warming) {
			this.requestFrame();
		}
		return { done, cpuMs };
	}

	/** the pool's evictions to the planner, and to the plan in flight's check */
	#evictions(): void {
		const gone = this.#pool.gone();
		if (!gone.length) return;
		this.#planner.evict(gone);
		for (const id of gone) this.#evicted.add(id);
	}

	/** asks for a plan when one is due and none is in flight */
	#request(): void {
		const tree = this.#tree;
		if (!tree || !this.#feed || this.#planning || this.#ready) return;
		if (!this.#stale && !this.#heading) return;
		this.#evictions();
		const views = this.#views(this.#moving);
		this.#moving = false;
		const request = { views, budget: this.#budget, capacity: this.#pool.capacity };
		this.#stale = false;
		this.#heading = views.length > 1;
		this.#evicted.clear();
		const planning: Promise<void> = this.#planner.plan(request, this.#applied).then((result) => {
			if (this.#planning !== planning) return;
			this.#planning = null;
			this.#ready = result;
			this.requestFrame();
		});
		this.#planning = planning;
	}

	/** the plan that came back, unless the pool let go of a page it reads; returns its mask changes */
	#apply(): Drawn[] {
		this.#evictions();
		const result = this.#ready;
		this.#ready = null;
		if (!result) return [];
		const pool = this.#pool;
		const tree = this.#tree!;
		this.#applied = result.touched.every((id) => pool.has(id) && !this.#evicted.has(id));
		if (!this.#applied) {
			this.#stale = true;
			return [];
		}
		pool.keep(result.touched);
		this.#plan = result;
		const load: PageNode[] = [];
		for (const id of result.load) {
			const page = tree.pages.get(id);
			if (page) load.push(page);
		}
		this.#wants = { keep: new Set(result.touched), load, idx: result.idx };
		return result.masks.map(([id, mask]) => ({ id, mask }));
	}

	/** the camera's view for the cut, and while it moves the view AHEAD_MS along its velocity */
	#views(moving: boolean): CutView[] {
		const c = this.#camera;
		const [width, height] = this.#target;
		// the full-scale size, so a lower render scale costs sharpness, not detail
		const scale = this.#quality.scale;
		const m = viewMatrix(this.#turn, [0, 0, 0], c.yaw * DEG, c.pitch * DEG);
		const rotation = [m[0], m[4], m[8], m[1], m[5], m[9], m[2], m[6], m[10]];
		const p11 = 1 / Math.tan((c.fov * DEG) / 2);
		const at = {
			rotation,
			p00: (p11 * height) / width,
			p11,
			width: width / scale,
			height: height / scale
		};
		const views: CutView[] = [{ ...at, eye: [c.e, c.n, c.h] }];
		const v = this.#velocity;
		if (moving && v.some((x) => x !== 0)) {
			const eye = [c.e + v[0] * AHEAD_MS, c.n + v[1] * AHEAD_MS, c.h + v[2] * AHEAD_MS] as const;
			views.push({ ...at, eye });
		}
		return views;
	}

	/** a pick answered with this frame's matrices, which its depth belongs to */
	#pick({ x, y, resolve }: Picking, frame: Frame): DepthPick {
		const view = this.#view.slice();
		const origin = this.#origin;
		const size = [frame.width, frame.height] as const;
		const point = (depth: number) => unproject([x, y], size, depth, frame.proj, view, origin);
		return { x, y, resolve: (depth) => resolve(depth === null ? null : point(depth)) };
	}

	/** a heights request in this frame's floating origin */
	#measure({ west, south, cells, resolve }: Measuring, origin: Point): HeightsRequest {
		return {
			x: west - origin[0],
			y: south - origin[1],
			cells,
			resolve: (tops) => {
				if (tops) for (let i = 0; i < tops.length; i++) tops[i] += origin[2];
				resolve(tops);
			}
		};
	}

	/** frame timings for stats, and the frame rate controller */
	#sample(now: number, cpuMs: number, moved: boolean): void {
		const quality = this.#quality;
		const { gpuMs } = this.#renderer.stats();
		const interval = now - this.#lastFrame;
		// queued work can span more than the idle-gap threshold
		const consecutive = interval <= Math.max(GAP_MS, 2 * gpuMs, 2 * cpuMs);
		if (consecutive) push(this.#frameMs, interval);
		push(this.#cpuMs, cpuMs);
		this.#lastFrame = now;
		const budget = quality.budget;
		// only moving frames adapt, so a still view stays sharp
		if (quality.sample(interval, now, consecutive && moved, this.#plan?.planned ?? 0)) {
			this.#fit();
			if (quality.budget !== budget) this.#rebudget();
		}
		if (moved) this.#movedAt = now;
		else if (quality.scale < 1 && now - this.#movedAt > STILL_MS) {
			quality.full();
			this.#fit();
		}
	}
}
