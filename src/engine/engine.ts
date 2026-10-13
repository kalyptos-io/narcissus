// the engine: world, planner, stream, pool and renderer behind one small api

import { CLUSTER, GEOMETRY_WORDS, directory, parseWorld, type World } from '../format/index.ts';
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
import { Planner, type Plan, type View } from './plan/cut.ts';
import { FADE_CAP, Fader } from './plan/draw.ts';
import type { Fetch } from '../ports.ts';
import type { Frame, Host, Plugin, Post, Shade } from './plugin.ts';
import { percentile, pixelRatio, Quality } from './quality.ts';
import { Feed } from './stream/feed.ts';
import { http } from '../adapters/http.ts';
import { Loader } from './stream/loader.ts';
import type { Camera, Drawn, Settings, Stats } from './types.ts';
import { Tree } from './world/tree.ts';

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
	/**
	 * tops, as world heights, of the solid splats the next frame draws over cells x cells of 1 m from the
	 * south-west corner (west, south), rows south to north, NaN where none; null if no frame comes
	 */
	heights(west: number, south: number, cells: number): Promise<Float32Array | null>;
	stats(): Stats;
	/** resolves once nothing loads and the cut is drawn without fades */
	idle(): Promise<void>;
	use(plugin: Plugin): () => void;
	/** device loss, with its reason; the engine is then dead */
	onLost(fn: (reason: string) => void): () => void;
	/** fn(now) starts each frame the loop draws, so a camera it sets shows in that frame */
	onFrame(fn: (now: number) => void): () => void;
	/** the camera may soon move: after a rest, frames run a moment so the gpu is up to speed by then */
	warm(): void;
	requestFrame(): void;
	/** one frame now, resolved when the gpu finished it */
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
/** splats one frame may project, per splat of budget: the plan's on screen, then pages fading out */
const FRAME_SHARE = 1 + FADE_CAP;
/** metres: the floating origin's grid, and how far the camera may stray from it */
const GRID = 1024;
const REBASE = 2048;
/** ms between plans while pages load and nothing else changes */
const REPLAN_MS = 100;
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
	#quality = new Quality();
	#pool: Pool;
	#renderer: Renderer;
	/** splats one frame may project */
	#frameCapacity: number;
	#planner = new Planner();
	#fader = new Fader();
	#has = (id: number) => this.#pool.has(id);

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
	#ahead = new Float64Array(16);
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
	#plan: Plan | null = null;
	#plannedAt = -Infinity;
	#moved = true;
	#dirty = true;
	/** the last plan looked ahead of a moving camera; the first frame it rests plans again */
	#heading = false;
	#arrived = false;
	#fading = false;
	#drawn = 0;
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
		const tree = new Tree(world);
		try {
			const roots = await Promise.all(world.roots.map((root) => loader.idx(root.idx)));
			check();
			roots.forEach((idx, k) => tree.add(idx, world.roots[k].idx));
		} catch (error) {
			loader.destroy();
			throw error;
		}

		this.#feed?.destroy();
		this.#feed = null;
		this.#loader?.destroy();
		this.#url = worldUrl;
		this.#tree = tree;
		this.#loader = loader;
		this.#plan = null;
		this.#planner = new Planner();
		this.#fader = new Fader();
		// page ids restart with the tree, so the old world's pages must leave the pool
		this.#pool.clear();
		this.#feed = this.#feedFor(tree, loader);
		this.#dirty = true;
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
		if (!this.#starting) this.requestFrame();
	}

	configure(settings: Partial<Settings>): void {
		if (this.#destroyed) return;
		this.#settings = { ...this.#settings, ...settings };
		const { pool, frame } = capacities(this.#budget, this.#gpu.device.limits);
		if (pool > this.#pool.capacity || frame > this.#frameCapacity) this.#rebuild(pool, frame);
		this.#dirty = true;
		this.requestFrame();
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
			pages: {
				resident: Array.from(pool.ids()).length,
				drawn: this.#drawn,
				loading: feed?.loading ?? 0,
				queued: feed?.queued ?? 0
			},
			memory: { pool: pool.bytes, buffers: gpu.bytes },
			capacity: pool.capacity,
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
		this.#renderer.destroy();
		this.#pool.destroy();
		for (const { resolve } of this.#picks.splice(0)) resolve(null);
		for (const { resolve } of this.#measures.splice(0)) resolve(null);
		for (const resolve of this.#idlers.splice(0)) resolve();
		this.#gpu.device.destroy();
	}

	/** the settings' budget, within what one frame can project on this device */
	get #budget(): number {
		const most = Math.floor(capacities(Infinity, this.#gpu.device.limits).frame / FRAME_SHARE);
		return Math.max(1, Math.min(this.#settings.budget, most));
	}

	/** a new pool and renderer; residency reloads through a new feed */
	#rebuild(capacity: number, frame: number): void {
		this.#feed?.destroy();
		this.#feed = null;
		this.#renderer.destroy();
		this.#pool.destroy();
		this.#pool = new Pool(this.#gpu.device, capacity);
		this.#pool.setOrigin(this.#origin);
		const renderer = new Renderer(this.#gpu, this.#context, this.#pool, frame);
		renderer.resize(...this.#target);
		for (const entry of this.#shades) entry.off = renderer.shade(entry.hook);
		for (const entry of this.#posts) entry.off = renderer.post(entry.hook);
		this.#renderer = renderer;
		this.#frameCapacity = frame;
		if (this.#tree && this.#loader) this.#feed = this.#feedFor(this.#tree, this.#loader);
		this.#plan = null;
		this.#dirty = true;
		this.requestFrame();
	}

	#feedFor(tree: Tree, loader: Loader): Feed {
		const arrive = () => {
			this.#arrived = true;
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
		this.#dirty = true;
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

		// plan
		const tree = this.#tree;
		const feed = this.#feed;
		let plan = this.#plan;
		if (tree && feed) {
			const due = !feed.idle && now - this.#plannedAt >= REPLAN_MS;
			const stale = this.#dirty || this.#arrived || this.#fading || this.#heading;
			if (!plan || moved || due || stale) {
				plan = this.#replan(tree, now, moved);
			}
		}

		// draw
		let drawn: Drawn[] = [];
		let fading = false;
		if (plan && feed) {
			({ drawn, fading } = this.#fader.update(plan.cut, this.#has, now, this.#budget));
			feed.update(plan, new Set(drawn.map((d) => d.id)), now);
		}
		if (pool.upload(UPLOAD_BYTES) > 0) this.#arrived = true;
		pool.draw(drawn);
		this.#fading = fading;
		this.#drawn = drawn.length;
		const picks = this.#picks.splice(0).map((picking) => this.#pick(picking, frame));
		const heights = this.#measures.splice(0).map((measuring) => this.#measure(measuring, origin));
		const done = this.#renderer.render(frame, this.#planes, this.#options.sky, picks, heights);
		const cpuMs = performance.now() - now;

		// what comes next
		const quiet =
			!this.#arrived &&
			!this.#heading &&
			!fading &&
			pool.queued === 0 &&
			(!feed || feed.idle) &&
			(!plan || (plan.load.length === 0 && plan.idx.length === 0));
		if (quiet && this.#idlers.length) {
			const idlers = this.#idlers.splice(0);
			void done.then(() => idlers.forEach((resolve) => resolve()));
		}
		if (animated) this.#sample(now, cpuMs, moved);
		// the feed calls onArrive for whatever it changes, so loads in flight need no frames
		const warming = now < this.#warmUntil;
		const pending = pool.queued > 0 || this.#arrived || this.#heading;
		if (pending || fading || quality.scale < 1 || warming) {
			this.requestFrame();
		}
		return { done, cpuMs };
	}

	/** moved: the camera moved this frame; a resting one plans for itself alone */
	#replan(tree: Tree, now: number, moved: boolean): Plan {
		const camera = this.#camera;
		const pool = this.#pool;
		const [width, height] = this.#target;
		// the full-scale size, so a lower render scale costs sharpness, not detail
		const scale = this.#quality.scale;
		const budget = this.#budget;
		const at = {
			origin: this.#origin,
			width: width / scale,
			height: height / scale,
			tan: Math.tan((camera.fov * DEG) / 2),
			near: NEAR,
			far: this.#settings.viewDistance
		};
		const view: View = { ...at, view: this.#view };
		const options = {
			budget,
			// pages the fader holds take up to FADE_CAP of the budget beside the plan's
			capacity: pool.capacity - Math.ceil(FADE_CAP * budget),
			now,
			predicted: moved ? this.#predict(at) : undefined
		};
		const plan = this.#planner.plan(tree, view, this.#has, options);
		this.#plan = plan;
		this.#plannedAt = now;
		this.#dirty = false;
		this.#heading = options.predicted !== undefined;
		this.#arrived = false;
		return plan;
	}

	/** the view AHEAD_MS along the camera's velocity */
	#predict(at: Omit<View, 'view'>): View | undefined {
		const v = this.#velocity;
		if (v.every((x) => x === 0)) return undefined;
		const c = this.#camera;
		const eye: Point = [
			c.e + v[0] * AHEAD_MS - at.origin[0],
			c.n + v[1] * AHEAD_MS - at.origin[1],
			c.h + v[2] * AHEAD_MS - at.origin[2]
		];
		return { ...at, view: viewMatrix(this.#ahead, eye, c.yaw * DEG, c.pitch * DEG) };
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

	/** frame timings for stats, and the render scale controller */
	#sample(now: number, cpuMs: number, moved: boolean): void {
		const quality = this.#quality;
		const consecutive = now - this.#lastFrame <= GAP_MS;
		if (consecutive) push(this.#frameMs, now - this.#lastFrame);
		push(this.#cpuMs, cpuMs);
		this.#lastFrame = now;
		// only moving frames adapt the scale, so a still view stays sharp
		if (quality.sample(this.#renderer.stats().gpuMs, now, consecutive && moved)) this.#fit();
		if (moved) this.#movedAt = now;
		else if (quality.scale < 1 && now - this.#movedAt > STILL_MS) {
			quality.full();
			this.#fit();
		}
	}
}
