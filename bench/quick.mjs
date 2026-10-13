// usage: [WORLD=<world dir>] [SOURCE=http|synthetic|page] [WORLD_URL=<remote world.json>] [POSE_A=e,n,h,yaw,pitch,dist] [POSE_B=e,n,h,yaw,pitch,dist] [BUDGET=4000000] [VIEW_DISTANCE=1500] [SKY=r,g,b] [PORT=9351] [PROFILE=<file> writes the moves' main-thread cpuprofile] node bench/quick.mjs [--baseline writes the baseline] [--stop closes chrome]
/** @import { AddressInfo } from 'node:net' */
/** @import { Options, Repetition } from './quick.ts' */
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { attach, launch, onConsole, stop, until } from './cdp.mjs';
import { files } from './h2serve.mjs';
import { shown, trace } from './trace.mjs';

const bench = import.meta.dirname;
const repo = resolve(bench, '..');
const out = join(bench, 'runs/quick');
const {
	WORLD = join(bench, 'runs/world'),
	SOURCE = 'http',
	WORLD_URL,
	POSE_A = '724706.45,6178123.51,24.14,230.3,-35,588.3',
	POSE_B = '724000,6178000,3.22,0,-35,80',
	BUDGET = '4000000',
	VIEW_DISTANCE = '1500',
	SKY = '0.62,0.72,0.8',
	PORT = '9351',
	PROFILE
} = process.env;
// a hung frame would leave an evaluate waiting forever
const TIMEOUT_MS = 120_000;
const port = Number(PORT);
const baselineFile = join(out, 'baseline.json');

if (process.argv.includes('--stop')) {
	console.log((await stop(port)) ? 'chrome closed' : `no chrome on port ${port}`);
	process.exit(0);
}
setTimeout(() => {
	console.error(`no result after ${TIMEOUT_MS} ms`);
	process.exit(1);
}, TIMEOUT_MS);

// build
const site = join(out, 'site');
const stamp = join(out, 'stamp');
/** @param {string} dir */
function newest(dir) {
	let time = lstatSync(dir).mtimeMs;
	for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
		const path = join(entry.parentPath, entry.name);
		if (!path.includes('/node_modules')) time = Math.max(time, lstatSync(path).mtimeMs);
	}
	return time;
}
const built = existsSync(stamp) ? Number(readFileSync(stamp, 'utf8')) : 0;
// all of src, since the page imports the controls besides the engine
const changed = Math.max(newest(join(repo, 'src')), newest(bench));
if (changed > built || !existsSync(join(site, 'quick.html'))) {
	const started = Date.now();
	await build({
		configFile: join(bench, 'vite.config.ts'),
		logLevel: 'error',
		build: {
			outDir: site,
			emptyOutDir: true,
			minify: false,
			rolldownOptions: { input: join(bench, 'quick.html') }
		}
	});
	writeFileSync(stamp, String(started));
}

// serve
const server = createServer(files(site, resolve(WORLD)));
await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
const address = /** @type {AddressInfo} */ (server.address());
const url = `http://127.0.0.1:${address.port}/quick.html`;

// measure
const marks = [['start', performance.now()]];
const mark = (/** @type {string} */ name) => marks.push([name, performance.now()]);
mark('built');
await launch(port, out, []);
const page = await attach(port);
await onConsole(page, (type, text) => console.error(`page ${type}: ${text}`));
await page.send('Page.navigate', { url });
await until('the page', 10_000, () =>
	page.evaluate(`location.href === '${url}' && 'bench' in window`).catch(() => false)
);
/** @type {Options} */
const options = {
	a: POSE_A,
	b: POSE_B,
	budget: Number(BUDGET),
	viewDistance: Number(VIEW_DISTANCE),
	sky: /** @type {[number, number, number]} */ (SKY.split(',').map(Number)),
	source: /** @type {Options['source']} */ (SOURCE),
	world: WORLD_URL
};
mark('chrome');
const { idleMs, adapter } = await page.evaluate(`bench.ready(${JSON.stringify(options)})`);
mark('ready');
/** @type {Repetition[]} */
const repetitions = await page.evaluate('bench.run()');
mark('poses');
// live objects only, else the reading follows the gc's timing
await page.send('HeapProfiler.collectGarbage');
const heap = await page.send('Runtime.getHeapUsage');
for (const repetition of repetitions) repetition.metrics.heapMiB = heap.usedSize / 2 ** 20;
if (PROFILE) {
	await page.send('Profiler.enable');
	await page.send('Profiler.setSamplingInterval', { interval: 100 });
	await page.send('Profiler.start');
}
const traced = await trace(port);
const moves = await page.evaluate('bench.move()');
// what chrome showed of the drag, beside the page's own count
const drag = shown(await traced.stop(), 'drag');
Object.assign(moves.metrics, {
	dragShownFps: drag.fps,
	dragShownMaxMs: drag.maxGapMs,
	dragDropped: drag.dropped,
	dragGpuMainShare: drag.gpuMainShare
});
if (PROFILE) writeFileSync(PROFILE, JSON.stringify((await page.send('Profiler.stop')).profile));
mark('moves');
console.error(
	marks
		.slice(1)
		.map(([name, at], i) => `${name} ${((Number(at) - Number(marks[i][1])) / 1000).toFixed(1)} s`)
		.join(', ')
);
// chrome stays up for the next run, so the page lets go of its gpu memory now
await page.send('Page.navigate', { url: 'about:blank' });
page.close();

// report
/** @param {number[]} values */
function median(values) {
	const sorted = values.toSorted((x, y) => x - y);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
/** @type {Record<string, number>} */
const metrics = {};
for (const name of new Set(repetitions.flatMap((r) => Object.keys(r.metrics)))) {
	metrics[name] = median(repetitions.map((r) => r.metrics[name] ?? 0));
}
Object.assign(metrics, moves.metrics, { idleMs });
const reasons = [...new Set([...repetitions, moves].flatMap((r) => r.reasons))];
const result = {
	time: new Date().toISOString(),
	adapter,
	valid: reasons.length === 0,
	reasons,
	world: resolve(WORLD),
	options,
	metrics
};
console.log(JSON.stringify(result));

/** @type {typeof result | undefined} */
const baseline = existsSync(baselineFile)
	? JSON.parse(readFileSync(baselineFile, 'utf8'))
	: undefined;
/** @param {number} v */
const fixed = (v) => v.toFixed(Math.abs(v) >= 100 ? 0 : 2);
const rows = [['metric', 'now', 'baseline', 'delta']];
for (const [name, value] of Object.entries(metrics)) {
	const base = baseline?.metrics[name];
	if (base === undefined) {
		rows.push([name, fixed(value), '', '']);
		continue;
	}
	const delta = base ? `${(((value - base) / base) * 100).toFixed(1)}%` : fixed(value - base);
	rows.push([name, fixed(value), fixed(base), `${value >= base ? '+' : ''}${delta}`]);
}
const widths = rows[0].map((_, c) => Math.max(...rows.map((row) => row[c].length)));
for (const row of rows) {
	const cells = row.map((cell, c) => (c ? cell.padStart(widths[c]) : cell.padEnd(widths[c])));
	console.error(cells.join('  '));
}
console.error(result.valid ? 'valid' : `invalid: ${reasons.join('; ')}`);

if (process.argv.includes('--baseline')) {
	if (!result.valid) {
		console.error('an invalid run makes no baseline');
		process.exit(1);
	}
	writeFileSync(baselineFile, `${JSON.stringify(result, null, 1)}\n`);
	console.error(`baseline written to ${baselineFile}`);
}
process.exit(result.valid ? 0 : 1);
