// animation frames, a cold cache and a route of poses

import { blend, createEngine, viewOf, type Engine, type Pose, type Stats } from '../src/index.ts';

export interface Options {
	budget: number;
	viewDistance: number;
	sky: [number, number, number];
}

export interface Sample extends Stats {
	/** epoch ms, so samples line up with the server's log */
	time: number;
	/** frames drawn per second since the previous sample */
	fps: number;
	hidden: boolean;
}

const WIDTH = 1920;
const HEIGHT = 1080;
const SAMPLE_MS = 250;
// a longer frame means a hidden or stalled window; the route waits instead of jumping
const STALL_MS = 250;

const canvas = document.querySelector('canvas')!;
const samples: Sample[] = [];
const arrivals: number[] = [];
let engine: Engine;
let frames = 0;
let sampled = 0;

const now = () => performance.timeOrigin + performance.now();

const look = (p: Pose) => engine.setCamera(viewOf(p));

function sample() {
	const time = now();
	if (time - sampled >= SAMPLE_MS) {
		const fps = (frames * 1000) / (time - sampled);
		samples.push({ ...engine.stats(), time, fps, hidden: document.hidden });
		frames = 0;
		sampled = time;
	}
	requestAnimationFrame(sample);
}

/** resolves at the first idle view of start, with the gpu adapter's name */
async function ready(options: Options, start: Pose) {
	engine = await createEngine(canvas, {
		settings: { budget: options.budget, viewDistance: options.viewDistance },
		sky: options.sky,
		cache: 'none'
	});
	engine.resize(WIDTH, HEIGHT, 1);
	engine.onLost((reason) => console.error(`device lost: ${reason}`));
	engine.onFrame(() => frames++);
	await engine.open(`${location.origin}/world/world.json`);
	look(start);
	sampled = now();
	requestAnimationFrame(sample);
	await engine.idle();
	const info = (await navigator.gpu.requestAdapter())?.info;
	return info ? info.description || `${info.vendor} ${info.architecture}` : 'none';
}

/** moves along route in ms of visible frames; arrivals holds when each pose was reached */
function run(route: Pose[], ms: number) {
	samples.length = 0;
	arrivals.length = 0;
	const { promise, resolve } = Promise.withResolvers<void>();
	let elapsed = 0;
	let last = performance.now();
	const move = () => {
		const time = performance.now();
		if (!document.hidden && time - last <= STALL_MS) elapsed += time - last;
		last = time;
		const progress = Math.min(1, elapsed / ms) * (route.length - 1);
		while (arrivals.length <= progress) arrivals.push(now());
		const index = Math.min(route.length - 2, Math.floor(progress));
		look(blend(route[index], route[index + 1], progress - index));
		if (progress < route.length - 1) requestAnimationFrame(move);
		else resolve();
	};
	requestAnimationFrame(move);
	return promise;
}

Object.assign(window, { bench: { ready, run, idle: () => engine.idle(), samples, arrivals } });
