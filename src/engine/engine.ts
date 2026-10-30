// the engine: world, planner, stream, pool and renderer behind one small api

import { CLUSTER, GEOMETRY_WORDS, directory, parseWorld, type World } from '../format/index.ts';
import { PROJECTED_WORDS, slots } from './gpu/layout.ts';
import { requestGpu, type Gpu } from './gpu/device.ts';
import { Pool } from './gpu/pool.ts';
import type { Capsule } from './gpu/overlay.ts';
import type { Found } from './gpu/pick.ts';
import { Renderer, type HeightsRequest } from './gpu/renderer.ts';
import { boxOf, layerPages, type Layer } from './layer.ts';
import type { Mask, MaskOptions } from './mask.ts';
import type { Line, LineStyle, Marker, MarkerStyle } from './overlay.ts';
import { boxVisible, planes } from './math/frustum.ts';
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

export interface Hit {
	/** where the pixel's ray meets the splat's depth, world coordinates */
	point: [number, number, number];
	/** unit; the splat's thinnest axis, toward the camera */
	normal: [number, number, number];
	/** null for the world */
	layer: Layer | null;
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
	/**
	 * a layer from a pack, its bytes or its url read through the engine's source; origin is the
	 * south-west corner its positions count from, as encodeLayer gives it. it stays through open()
	 */
	addLayer(
		source: { url: string } | { bytes: Uint8Array },
		origin: readonly [number, number]
	): Promise<Layer>;
	addMask(mask: MaskOptions): Mask;
	/** a polyline in world coordinates over the splats; one point draws a dot */
	addLine(points: readonly Point[], style?: LineStyle): Line;
	addMarker(point: Point, style?: MarkerStyle): Marker;
	/** canvas css pixel of a world point under the camera set last, null behind it */
	toScreen(point: Point): [number, number] | null;
	setCamera(camera: Camera): void;
	configure(settings: Partial<Settings>): void;
	/** canvas size in css pixels and the device pixel ratio to render at */
	resize(width: number, height: number, ratio: number): void;
	/**
	 * the surface under canvas css pixel (x, y), or null over nothing: the nearest splat that draws
	 * it at 0.5 opacity or more, as the last frame showed it; it renders no frame of its own
	 */
	pick(x: number, y: number): Promise<Hit | null>;
	ground(e: number, n: number): number | undefined;
	/** ground(e, n) once every .idx over (e, n) is read */
	groundAt(e: number, n: number): Promise<number | undefined>;
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
/** splats the pool holds, per splat of budget: the plan's room, then pages held for fades */
const POOL_SHARE = 2.25 + FADE_CAP;
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
const NO_ROOM = 'The layers hold more splats than this device can.';
const WHITE = [1, 1, 1, 1] as const;
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

/** points as given; throws on none, or on one that is not three finite numbers */
function finite(points: readonly Point[]): readonly Point[] {
	if (!points.length || !points.every((p) => p.length === 3 && p.every(Number.isFinite))) {
		throw new Error('Give at least one point, each three finite numbers.');
	}
	return points;
}

function relative(c: Camera, origin: Point): Point {
	return [c.e - origin[0], c.n - origin[1], c.h - origin[2]];
}

function push(samples: number[], value: number): void {
	samples.push(value);
	if (samples.length > SAMPLES) samples.shift();
}

interface Shown {
	layer: Layer | null;
	pages: { id: number; count: number; box: Float64Array }[];
	visible: boolean;
	opacity: number;
}

interface Installed<T> {
	hook: T;
	off: () => void;
}

interface Picking {
	/** canvas css pixels */
	x: number;
	y: number;
	resolve: (hit: Hit | null) => void;
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
	#fader = new Fader();
	#has = (id: number) => this.#pool.has(id);

	#url: string | null = null;
	#tree: Tree | null = null;
	#loader: Loader | null = null;
	#feed: Feed | null = null;
	#opening = 0;
	#reopening = false;

	#layers = new Map<number, Shown>();
	#layerCount = 0;
	/** layer page ids count down from -1, apart from the tree's */
	#layerPage = 0;
	/** pool splats the layers' pages pin */
	#pinned = 0;
	#layerNumbers = new WeakMap<Layer, number>();
	#layerDrawn: Drawn[] = [];
	/** the pool draws anew though the cut stays: layers or masks changed */
	#redraw = false;
	/** lines and markers by id, radius in css pixels */
	#graphics = new Map<number, Capsule[]>();
	#graphicCount = 0;
	#reshaped = false;

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
	#drawn: Drawn[] = [];
	#lastFrame = -Infinity;
	#warmUntil = -Infinity;
	#movedAt = -Infinity;
	#frameMs: number[] = [];
	#cpuMs: number[] = [];

	#shades: Installed<Shade>[] = [];
	#posts: Installed<Post>[] = [];
	#picks: Picking[] = [];
	/** the last frame submitted and its float64 view; null while the gpu holds none to pick in */
	#rendered: { frame: Frame; view: Float64Array } | null = null;
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

	async addLayer(
		source: { url: string } | { bytes: Uint8Array },
		origin: readonly [number, number]
	): Promise<Layer> {
		if (this.#destroyed) throw new Error(DESTROYED);
		const bytes = 'bytes' in source ? source.bytes : await this.#fetch(source.url, null);
		const pages = await layerPages(bytes, origin);
		if (this.#destroyed) throw new Error(DESTROYED);
		const pinned = pages.reduce((sum, { page }) => sum + slots(page.count), 0);
		const limits = this.#gpu.device.limits;
		const room = capacities(this.#budget, limits).pool + this.#pinned + pinned;
		if (room > capacities(Infinity, limits).pool) throw new Error(NO_ROOM);
		this.#pinned += pinned;
		this.#rebudget();

		const number = ++this.#layerCount;
		const drawn = new Set(this.#drawn.map((d) => d.id));
		const keep = (id: number) => drawn.has(id) || (this.#plan?.keep.has(id) ?? false);
		const shown: Shown = { layer: null, pages: [], visible: true, opacity: 1 };
		const remove = () => {
			if (this.#destroyed || !this.#layers.delete(number)) return;
			for (const { id } of shown.pages) this.#pool.remove(id);
			this.#pinned -= pinned;
			this.#changeLayers();
		};
		this.#layers.set(number, shown);
		for (const { page, box } of pages) {
			const id = --this.#layerPage;
			if (!this.#pool.add(id, page, origin, keep, number)) {
				remove();
				throw new Error(NO_ROOM);
			}
			shown.pages.push({ id, count: page.count, box });
		}
		this.#changeLayers();
		const changed = () => this.#changeLayers();
		const layer: Layer = {
			splats: shown.pages.reduce((sum, { count }) => sum + count, 0),
			box: boxOf(pages.map(({ box }) => box)),
			get visible() {
				return shown.visible;
			},
			set visible(visible: boolean) {
				shown.visible = visible;
				changed();
			},
			get opacity() {
				return shown.opacity;
			},
			set opacity(opacity: number) {
				shown.opacity = Math.min(1, Math.max(0, opacity));
				changed();
			},
			remove
		};
		this.#layerNumbers.set(layer, number);
		shown.layer = layer;
		return layer;
	}

	addMask({ polygon, z = [-Infinity, Infinity], targets }: MaskOptions): Mask {
		if (this.#destroyed) throw new Error(DESTROYED);
		if (polygon.length < 3 || !polygon.flat().every(Number.isFinite)) {
			throw new Error('A mask needs three or more corners, each two finite numbers.');
		}
		const layers = new Set(
			targets.map((t) => (t === 'world' ? 0 : (this.#layerNumbers.get(t) ?? -1)))
		);
		const masks = this.#pool.masks;
		const prism = { polygon: Float64Array.from(polygon.flat()), z: [z[0], z[1]] as const };
		const id = masks.add(prism, layers);
		const area = masks.area(id)!;
		let enabled = true;
		let removed = false;
		const remask = () => {
			if (this.#destroyed) return;
			this.#pool.remask(area);
			this.#redraw = true;
			this.requestFrame();
		};
		remask();
		return {
			get enabled() {
				return enabled;
			},
			set enabled(on: boolean) {
				if (removed || on === enabled) return;
				enabled = on;
				masks.enable(id, on);
				remask();
			},
			remove() {
				if (removed) return;
				removed = true;
				masks.delete(id);
				remask();
			}
		};
	}

	addLine(points: readonly Point[], style: LineStyle = {}): Line {
		const { colour = WHITE, width = 2, closed = false, occlude = true } = style;
		const capsules = (points: readonly Point[]) => {
			const ends = closed && points.length > 2 ? [...points, points[0]] : points;
			const pairs =
				ends.length > 1 ? ends.slice(1).map((b, k) => [ends[k], b]) : [[ends[0], ends[0]]];
			return pairs.map(([a, b]) => ({ a, b, radius: width / 2, colour, occlude }));
		};
		const { set, remove } = this.#graphic(capsules(finite(points)));
		return { set: (points) => set(capsules(finite(points))), remove };
	}

	addMarker(point: Point, style: MarkerStyle = {}): Marker {
		const { colour = WHITE, size = 12, occlude = true } = style;
		const capsules = (point: Point) => {
			const [a] = finite([point]);
			return [{ a, b: a, radius: size / 2, colour, occlude }];
		};
		const { set, remove } = this.#graphic(capsules(point));
		return { set: (point) => set(capsules(point)), remove };
	}

	toScreen([e, n, h]: Point): [number, number] | null {
		const c = this.#camera;
		const [width, height] = this.#css;
		const o = this.#origin;
		const view = viewMatrix(new Float64Array(16), relative(c, o), c.yaw * DEG, c.pitch * DEG);
		const proj = perspective(
			new Float64Array(16),
			c.fov * DEG,
			width / Math.max(1, height),
			NEAR,
			this.#settings.viewDistance
		);
		const m = multiply(new Float64Array(16), proj, view);
		const [x, y, , w] = transform(m, [e - o[0], n - o[1], h - o[2]]);
		if (w <= 0) return null;
		return [((x / w) * 0.5 + 0.5) * width, (0.5 - (y / w) * 0.5) * height];
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

	pick(x: number, y: number): Promise<Hit | null> {
		if (this.#destroyed || this.#lost) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.#picks.push({ x, y, resolve });
			if (this.#rendered) this.#answer();
			else this.requestFrame();
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
		this.#arrived = true;
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
			pages: {
				resident: Array.from(pool.ids()).length,
				drawn: this.#drawn.length,
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
		this.#layers.clear();
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
		const room = pool + this.#pinned;
		if (room > this.#pool.capacity || frame > this.#frameCapacity) this.#grow(room, frame);
		this.#dirty = true;
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
		this.#rendered = null;
		this.#reshaped = true;
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

	/** a graphic of capsules, radius in css pixels: set replaces them, remove frees it */
	#graphic(capsules: Capsule[]): { set: (capsules: Capsule[]) => void; remove: () => void } {
		const id = ++this.#graphicCount;
		const reshape = () => {
			this.#reshaped = true;
			this.requestFrame();
		};
		this.#graphics.set(id, capsules);
		reshape();
		return {
			set: (capsules) => {
				if (!this.#graphics.has(id)) return;
				this.#graphics.set(id, capsules);
				reshape();
			},
			remove: () => {
				if (this.#graphics.delete(id)) reshape();
			}
		};
	}

	/** the layers' pages draw anew, and the plan's budget changes with them */
	#changeLayers(): void {
		this.#redraw = true;
		this.#dirty = true;
		this.requestFrame();
	}

	/** splats of the visible layers' pages in view, which the plan leaves room for */
	#layerSplats(): number {
		const o = this.#origin;
		const min = [0, 0, 0];
		const max = [0, 0, 0];
		let sum = 0;
		for (const { pages, visible, opacity } of this.#layers.values()) {
			if (!visible || opacity === 0) continue;
			for (const { count, box } of pages) {
				for (let a = 0; a < 3; a++) {
					min[a] = box[a] - o[a];
					max[a] = box[a + 3] - o[a];
				}
				if (boxVisible(this.#planes, min, max)) sum += count;
			}
		}
		return sum;
	}

	/** the visible layers' pages, every quadrant at the layer's opacity */
	#drawLayers(): Drawn[] {
		const drawn: Drawn[] = [];
		for (const { pages, visible, opacity } of this.#layers.values()) {
			const byte = Math.round(opacity * 255);
			if (!visible || byte === 0) continue;
			for (const { id } of pages) drawn.push({ id, factors: (byte * 0x01010101) >>> 0 });
		}
		return drawn;
	}

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
		this.#reshaped = true;
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
			this.#reshaped = true;
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
		const redraw = this.#arrived || this.#dirty || this.#fading;
		const previous = this.#plan;
		let plan = previous;
		if (tree && feed) {
			const due = !feed.idle && now - this.#plannedAt >= REPLAN_MS;
			const stale = this.#dirty || this.#arrived || this.#fading || this.#heading;
			if (!plan || moved || due || stale) {
				plan = this.#replan(tree, now, moved);
			}
		}

		// draw
		let drawn = this.#drawn;
		let fading = this.#fading;
		if (plan && feed) {
			// camera motion can leave the same opaque cover
			if (
				plan !== previous &&
				(redraw ||
					!previous ||
					plan.cut.length !== previous.cut.length ||
					plan.cut.some((page, k) => page !== previous.cut[k]))
			) {
				({ drawn, fading } = this.#fader.update(plan.cut, this.#has, now, this.#budget));
			}
			feed.update(plan, new Set(drawn.map((d) => d.id)), now);
		}
		if (pool.upload(UPLOAD_BYTES) > 0) this.#arrived = true;
		const restyled = this.#redraw;
		if (restyled) {
			this.#layerDrawn = this.#drawLayers();
			this.#redraw = false;
		}
		if (drawn !== this.#drawn || this.#arrived || restyled) {
			pool.draw(this.#layerDrawn.length ? drawn.concat(this.#layerDrawn) : drawn);
		}
		this.#fading = fading;
		this.#drawn = drawn;
		if (this.#reshaped) {
			this.#reshaped = false;
			const ratio = width / Math.max(1, this.#css[0]);
			const capsules = [...this.#graphics.values()].flat();
			const scaled = capsules.map((c) => ({ ...c, radius: c.radius * ratio }));
			this.#renderer.overlay(scaled, origin);
		}
		const heights = this.#measures.splice(0).map((measuring) => this.#measure(measuring, origin));
		const done = this.#renderer.render(frame, this.#planes, this.#options.sky, heights);
		this.#rendered = { frame, view: this.#view.slice() };
		if (this.#picks.length) this.#answer();
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
			budget: Math.max(0, budget - this.#layerSplats()),
			// pages the fader holds take up to FADE_CAP of the budget beside the plan's
			capacity: pool.capacity - Math.ceil(FADE_CAP * budget) - this.#pinned,
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

	/** the waiting picks against the last frame, whose uniforms and cull the gpu still holds */
	#answer(): void {
		const { frame, view } = this.#rendered!;
		const [cssWidth, cssHeight] = this.#css;
		const size = [frame.width, frame.height] as const;
		for (const { x, y, resolve } of this.#picks.splice(0)) {
			const pixel = [
				(x * size[0]) / Math.max(1, cssWidth),
				(y * size[1]) / Math.max(1, cssHeight)
			] as const;
			const hit = (found: Found | null): Hit | null =>
				found && {
					point: unproject(pixel, size, found.depth, frame.proj, view, frame.origin),
					normal: found.normal,
					layer: found.layer ? (this.#layers.get(found.layer)?.layer ?? null) : null
				};
			void this.#renderer.pick(pixel[0], pixel[1], frame).then((found) => resolve(hit(found)));
		}
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
