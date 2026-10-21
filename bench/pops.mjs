// usage: OUT=<dir> [WORLD=<world dir>|synthetic] [FOCUS=e,n,h,yaw,pitch] [BUDGET=1000000] [FRAMES=600] [PORT=9362] node bench/pops.mjs
// a zoom route stepped on a fixed clock; each pose drawn, the next frame's change made, and the pose drawn again: the two images' difference is what the cut's change alone did
/** @import { AddressInfo } from 'node:net' */
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { attach, launch, onConsole, until } from './cdp.mjs';
import { files } from './h2serve.mjs';

const bench = import.meta.dirname;
const {
	OUT,
	WORLD = 'synthetic',
	// on the synthetic ground
	FOCUS = '863875,6120875,19.02,30,-35',
	BUDGET = '1000000',
	FRAMES = '600',
	PORT = '9362'
} = process.env;
if (!OUT) throw new Error('OUT is required');
const out = resolve(OUT);
mkdirSync(out, { recursive: true });
const DT = 1000 / 60;
const sky = [0.62, 0.72, 0.8];
/** a frame whose difference passes this share of pixels moved past 10 is a pop */
const POP = 0.002;

const site = join(bench, 'runs/pops/site');
await build({
	configFile: join(bench, 'vite.config.ts'),
	logLevel: 'error',
	build: {
		outDir: site,
		emptyOutDir: true,
		minify: false,
		rolldownOptions: { input: join(bench, 'pops.html') }
	}
});
const world = WORLD === 'synthetic' ? WORLD : resolve(WORLD);
/** @type {{ rttMs: number, mbps: number, served: [number, number][] }} */
const link = { rttMs: 0, mbps: 1e9, served: [] };
const server = createServer(files(site, world, link));
await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
const address = /** @type {AddressInfo} */ (server.address());
const url = `http://127.0.0.1:${address.port}/pops.html`;

await launch(Number(PORT), join(bench, 'runs/pops'), []);
const page = await attach(Number(PORT));
await onConsole(page, (type, text) => console.error(`page ${type}: ${text}`));
await page.send('Page.navigate', { url });
await until('the page', 20_000, () =>
	page.evaluate(`location.href === '${url}' && 'pops' in window`).catch(() => false)
);
const adapter = await page.evaluate(
	`pops.ready(${JSON.stringify({ budget: Number(BUDGET), sky })})`
);

const n = Number(FRAMES);
const [e, north, h, yaw, pitch] = FOCUS.split(',').map(Number);
const focus = { e, n: north, h, yaw, pitch };
const route = Array.from({ length: n }, (_, k) => ({
	...focus,
	dist: 1200 * (50 / 1200) ** (k / (n - 1))
}));
/** @type {(pose: object, dt: number) => Promise<{ drawn: number, planned: number, missing: number, loading: boolean }>} */
const frame = (pose, dt) => page.evaluate(`pops.frame(${JSON.stringify(pose)}, ${dt})`);
/** a screenshot as base64 png */
const shot = async () => {
	const { data } = await page.send('Page.captureScreenshot', {
		format: 'png',
		clip: { x: 0, y: 0, width: 960, height: 540, scale: 1 }
	});
	return /** @type {string} */ (data);
};
/** @type {(a: string, b: string) => Promise<{ mad: number, over10: number, over30: number }>} */
const diff = (a, b) => page.evaluate(`pops.diff(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
/** @param {string} name @param {string} png */
const save = (name, png) => writeFileSync(join(out, name), Buffer.from(png, 'base64'));

// warm on the first pose until nothing loads for a second of frames
let quiet = 0;
for (let k = 0; k < 3000 && quiet < 60; k++) {
	const s = await frame(route[0], DT);
	quiet = s.loading || s.missing ? 0 : quiet + 1;
}
const warmBytes = link.served.reduce((sum, [, b]) => sum + b, 0);
const rows = [];
await frame(route[0], DT);
let a = await shot();
for (let i = 0; i < n - 1; i++) {
	const stats = await frame(route[i + 1], DT);
	const next = await shot();
	await frame(route[i], 0);
	const b = await shot();
	const d = await diff(a, b);
	rows.push({ i, dist: route[i].dist, ...d, ...stats });
	if (d.over10 > POP) {
		save(`pop-${i}-a.png`, a);
		save(`pop-${i}-b.png`, b);
	}
	if (i % 100 === 0) save(`frame-${i}.png`, a);
	a = next;
}
const bytes = link.served.reduce((sum, [, b]) => sum + b, 0);
writeFileSync(join(out, 'rows.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const summary = {
	world,
	focus,
	budget: Number(BUDGET),
	adapter,
	frames: rows.length,
	pops: rows.filter((r) => r.over10 > POP).length,
	warmBytes,
	bytes
};
writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary));
await page.send('Page.navigate', { url: 'about:blank' });
page.close();
server.close();
process.exit(0);
