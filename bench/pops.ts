// narcissus stepped by hand on the page's fixed clock, for the pop measure in pops.mjs

import { createEngine, viewOf, type Engine, type Pose } from '../src/index.ts';

const W = 960;
const H = 540;
const canvas = document.querySelector('canvas')!;
const clock = (window as unknown as { __clock: { add: (ms: number) => void } }).__clock;
const decoder = new OffscreenCanvas(W, H).getContext('2d', { willReadFrequently: true })!;
let engine: Engine;

async function ready(options: { budget: number; sky: [number, number, number] }) {
	engine = await createEngine(canvas, {
		settings: { budget: options.budget, viewDistance: 3000 },
		sky: options.sky,
		cache: 'memory',
		manual: true
	});
	engine.resize(W, H, 1);
	await engine.open(`${location.origin}/world/world.json`);
	const info = (await navigator.gpu.requestAdapter())?.info;
	return info ? info.description || `${info.vendor} ${info.architecture}` : 'none';
}

async function frame(pose: Pose, dt: number) {
	clock.add(dt);
	engine.setCamera(viewOf(pose));
	await engine.step();
	// worker replies land between frames
	await new Promise((r) => setTimeout(r, 0));
	const s = engine.stats();
	return { drawn: s.drawn, planned: s.planned, missing: s.missing, loading: s.loading };
}

/** the rgba of a base64 png screenshot */
async function pixels(png: string): Promise<Uint8ClampedArray> {
	const blob = await (await fetch(`data:image/png;base64,${png}`)).blob();
	decoder.drawImage(await createImageBitmap(blob), 0, 0);
	return decoder.getImageData(0, 0, W, H).data;
}

/** mean absolute difference, 0..255, and the share of pixels whose largest channel moved past 10 and 30 */
async function diff(a: string, b: string) {
	const x = await pixels(a);
	const y = await pixels(b);
	let sum = 0;
	let over10 = 0;
	let over30 = 0;
	const count = x.length / 4;
	for (let p = 0; p < x.length; p += 4) {
		const dr = Math.abs(x[p] - y[p]);
		const dg = Math.abs(x[p + 1] - y[p + 1]);
		const db = Math.abs(x[p + 2] - y[p + 2]);
		const d = Math.max(dr, dg, db);
		sum += (dr + dg + db) / 3;
		if (d > 10) over10++;
		if (d > 30) over30++;
	}
	return { mad: sum / count, over10: over10 / count, over30: over30 / count };
}

Object.assign(window, { pops: { ready, frame, diff } });
