// usage: OUT=<dir outside the repo> [WORLD=<world dir>] [PORT=9341] [MBPS=27 megabytes/s] [RTT=30 ms] [ROUTE_MS=90000] [BUDGET=4000000] [VIEW_DISTANCE=1500] node bench/drive.mjs
/** @import { AddressInfo } from 'node:net' */
/** @import { Options, Sample } from './drive.ts' */
import { rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { build } from 'vite';
import { attach, launch, listening, onConsole, until, within } from './cdp.mjs';
import { serve } from './h2serve.mjs';

const bench = import.meta.dirname;
const {
	OUT,
	WORLD = join(bench, 'runs/world'),
	PORT = '9341',
	MBPS = '27',
	RTT = '30',
	ROUTE_MS = '90000',
	BUDGET = '4000000',
	VIEW_DISTANCE = '1500'
} = process.env;
if (!OUT) throw new Error('OUT is required');
const out = resolve(OUT);
if (relative(resolve(bench, '..'), out).split('/')[0] !== '..')
	throw new Error('OUT must lie outside the repo');

const overview = { e: 724000, n: 6178000, h: 3.22, yaw: 0, pitch: -60, dist: 1200 };
const close = { ...overview, pitch: -35, dist: 80 };
const back = { ...close, yaw: 180 };
const east = { e: 724500, n: 6178400, h: 3.72, yaw: 90, pitch: -45, dist: 300 };
const west = { e: 723500, n: 6177600, h: 8.8, yaw: 270, pitch: -35, dist: 300 };
// eyes and focus inside world6 level 0; each move ends in a hold as long, so arrivals settle in place
const route = [overview, close, close, back, back, east, east, west, west, overview, overview];
const LOAD_MS = 120_000;
const routeMs = Number(ROUTE_MS);
/** @type {Options} */
const options = {
	budget: Number(BUDGET),
	viewDistance: Number(VIEW_DISTANCE),
	sky: [0.62, 0.72, 0.8]
};

process.on('SIGINT', () => process.exit(1));
process.on('SIGTERM', () => process.exit(1));

await build({
	configFile: join(bench, 'vite.config.ts'),
	logLevel: 'error',
	build: {
		outDir: join(out, 'site'),
		emptyOutDir: true,
		minify: false,
		rolldownOptions: { input: join(bench, 'drive.html') }
	}
});
/** @type {[number, number][]} */
const served = [];
const link = { rttMs: Number(RTT), mbps: Number(MBPS), served };
const server = await serve(join(out, 'site'), resolve(WORLD), out, 0, link);
const address = /** @type {AddressInfo} */ (server.address());
const url = `https://127.0.0.1:${address.port}/drive.html`;

const port = Number(PORT);
// other sessions run chrome with devtools ports; one already there would take this bench's commands
if (await listening(port)) throw new Error(`port ${PORT} already serves devtools`);
rmSync(join(out, 'chrome'), { recursive: true, force: true });
const chrome = await launch(port, out, ['--ignore-certificate-errors']);
process.on('exit', () => chrome?.kill());
const page = await attach(port);
/** @type {string[]} */
const errors = [];
await onConsole(page, (type, text) => {
	if (type === 'error' || type === 'exception') errors.push(text);
});
await page.send('Emulation.setDeviceMetricsOverride', {
	width: 1920,
	height: 1080,
	deviceScaleFactor: 1,
	mobile: false
});

const started = Date.now();
await page.send('Page.navigate', { url });
await until('the page', LOAD_MS, () =>
	page.evaluate(`location.href === '${url}' && 'bench' in window`).catch(() => false)
);
const ready = `bench.ready(${JSON.stringify(options)}, ${JSON.stringify(route[0])})`;
const adapter = await within('the first view', LOAD_MS, page.evaluate(ready));
const loadMs = Date.now() - started;
const cold = {
	requests: served.length,
	megabytes: served.reduce((sum, [, bytes]) => sum + bytes, 0) / 1e6
};

const run = `bench.run(${JSON.stringify(route)}, ${routeMs})`;
await within('the route', routeMs + LOAD_MS, page.evaluate(run));
// the settled last pose compares across builds
await within('the last view', LOAD_MS, page.evaluate('bench.idle()')).catch(() => {});
await sleep(2000);
const shot = await page.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(join(out, 'end.png'), Buffer.from(shot.data, 'base64'));
/** @type {Sample[]} */
const samples = await page.evaluate('bench.samples');
/** @type {number[]} */
const arrivals = await page.evaluate('bench.arrivals');

// the link paces bytes at the server, so they leave it as the browser receives them
const rows = samples.map((sample) => {
	const sent = served.filter(([time]) => time <= sample.time);
	const bytes = sent.reduce((sum, [, size]) => sum + size, 0);
	return { ...sample, requests: sent.length, bytes };
});
const first = rows[0];
const last = rows[rows.length - 1];
/** @type {(values: number[], q: number) => number} */
const rank = (values, q) =>
	values.toSorted((x, y) => x - y)[Math.max(0, Math.ceil(q * values.length) - 1)];
/** @type {(a: object, b: object) => boolean} */
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const changes = route.flatMap((p, i) => (i > 0 && !same(p, route[i - 1]) ? [i] : []));
// from reaching a new pose until nothing loads, before the next new pose; null if it never is
const settle = changes.map((i, k) => {
	const from = arrivals[i];
	const to = arrivals[changes[k + 1]] ?? Infinity;
	const done = rows.find((s) => s.time >= from && s.time < to && !s.loading);
	return { pose: i, ms: done ? done.time - from : null };
});
// frames come on demand, so an idle hold draws none; fps counts the moves alone
const moving = rows.filter((s) =>
	changes.some((i) => s.time > arrivals[i - 1] && s.time <= arrivals[i])
);
const fps = moving.map((s) => s.fps);
const gpu = rows.map((s) => s.gpuMs);
const drawn = rows.map((s) => s.drawn);
const summary = {
	page: url,
	world: resolve(WORLD),
	mbps: Number(MBPS),
	rttMs: Number(RTT),
	routeMs,
	route,
	options,
	adapter,
	errors,
	loadMs,
	cold,
	seconds: (last.time - first.time) / 1000,
	requests: last.requests - first.requests,
	megabytes: (last.bytes - first.bytes) / 1e6,
	fps: { p5: rank(fps, 0.05), p50: rank(fps, 0.5) },
	gpuMs: { p50: rank(gpu, 0.5), p95: rank(gpu, 0.95) },
	drawn: rank(drawn, 0.5),
	resident: Math.max(...rows.map((s) => s.pages.resident)),
	settle
};
writeFileSync(join(out, 'result.json'), JSON.stringify({ ...summary, samples: rows }));
console.log(JSON.stringify({ ...summary, route: undefined, options: undefined }, null, 1));
process.exit(0);
