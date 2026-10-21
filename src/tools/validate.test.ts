import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disk } from '../adapters/disk.ts';
import { link } from '../format/encode.ts';
import { probe, validate } from './validate.ts';
import { build, write, type Unit } from './test-world.ts';

const scratch = mkdtempSync(join(tmpdir(), 'narcissus-'));
afterAll(() => rmSync(scratch, { recursive: true }));

const LEAF = 'u/0/723000/6177000.';
const ROOT = 'u/1/723000/6177000.';
let files: string[] = [];
const sound = join(scratch, 'sound');
beforeAll(async () => {
	files = await write(sound, build());
});

const file = (prefix: string, ext: string) =>
	files.find((path) => path.startsWith(prefix) && path.endsWith(ext))!;

/** a world written with change made to its units first; returns its world.json and files */
async function changed(name: string, change: (units: Unit[]) => void) {
	const units = build();
	change(units);
	const dir = join(scratch, name);
	const written = await write(dir, units);
	const at = (prefix: string, ext: string) =>
		written.find((path) => path.startsWith(prefix) && path.endsWith(ext))!;
	return { world: `${dir}/world.json`, at };
}

/** a copy of the sound world with change made to its files */
async function broken(name: string, change: (dir: string) => void): Promise<string> {
	const dir = join(scratch, name);
	await write(dir, build());
	change(dir);
	return `${dir}/world.json`;
}

const deep = async (world: string) => (await validate(disk, world, { deep: true })).faults;

describe('validate', () => {
	it('finds no fault in a sound world, deep or not', async () => {
		const units = files.filter((path) => path !== 'world.json');
		const bytes = units.reduce((sum, path) => sum + statSync(join(sound, path)).size, 0);
		for (const deep of [false, true]) {
			const report = await validate(disk, `${sound}/world.json`, { deep });
			expect(report).toEqual({ units: 3, files: 7, bytes, faults: [] });
		}
	});

	it('names a missing file', async () => {
		const col = file(LEAF, '.col');
		const world = await broken('missing', (dir) => rmSync(join(dir, col)));
		const { faults } = await validate(disk, world);
		expect(faults).toEqual([{ path: col, fault: 'is missing' }]);
	});

	it('names a pack that is cut short', async () => {
		const pack = file(LEAF, '.pack');
		const world = await broken('short', (dir) => {
			writeFileSync(join(dir, pack), readFileSync(join(dir, pack)).subarray(0, -10));
		});
		const { faults } = await validate(disk, world);
		expect(faults.map((f) => f.path)).toEqual([pack]);
	});

	it('names a pack with one byte changed, when deep', async () => {
		const pack = file(LEAF, '.pack');
		const world = await broken('flipped', (dir) => {
			const bytes = readFileSync(join(dir, pack));
			bytes[100] ^= 1;
			writeFileSync(join(dir, pack), bytes);
		});
		expect((await validate(disk, world)).faults).toEqual([]);
		const faults = await deep(world);
		expect(faults).toContainEqual({ path: pack, fault: 'does not have the hash in its name' });
		expect(new Set(faults.map((f) => f.path))).toEqual(new Set([pack]));
	});

	it('reports a world.json that does not parse and goes no further', async () => {
		const world = await broken('unreadable', (dir) => writeFileSync(join(dir, 'world.json'), '{}'));
		const report = await validate(disk, world);
		expect(report.units).toBe(0);
		expect(report.faults).toEqual([
			{ path: 'world.json', fault: 'This world is version undefined; narcissus reads 2.' }
		]);
	});

	it('names a family two parents link and the one neither does', async () => {
		const { world, at } = await changed('twice', ([, leaf]) => {
			const [first, second] = leaf.pages[2].nodes;
			second.link = first.link;
		});
		expect(await deep(world)).toEqual([
			{ path: at(LEAF, '.pack'), fault: 'page 0/0/0 has nodes reached more than once (4 times)' },
			{ path: at(LEAF, '.pack'), fault: 'page 0/0/0 has 4 nodes not reached from the top' }
		]);
	});

	it('names a node no family holds', async () => {
		const { world, at } = await changed('orphan', ([, leaf]) => {
			leaf.pages[1].nodes.push({ ...leaf.pages[1].nodes[0], position: [20, 5, 9] });
		});
		expect(await deep(world)).toEqual([
			{ path: at(LEAF, '.pack'), fault: 'page 0/1/0 has 1 nodes not reached from the top' }
		]);
	});

	it('names a link past its page and one to a child its unit does not name', async () => {
		const { world, at } = await changed('links', ([root, leaf]) => {
			leaf.pages[2].nodes[11].link = link(0, 1, 22);
			root.pages[0].nodes[0].link = link(3, 2, 0);
		});
		const faults = await deep(world);
		expect(faults).toContainEqual({
			path: at(ROOT, '.pack'),
			fault: 'page 2/0/0 links to a child unit it does not name'
		});
		expect(faults).toContainEqual({
			path: at(LEAF, '.pack'),
			fault: 'has links to a family past page 0/1/0'
		});
	});

	it('names a page whose box its nodes reach past', async () => {
		const { world, at } = await changed('box', ([, leaf]) => {
			leaf.pages[0].box = Float32Array.of(0, 0, 8, 15.625, 15.625, 12);
		});
		const faults = await deep(world);
		expect(faults).toHaveLength(1);
		expect(faults[0].path).toBe(at(LEAF, '.pack'));
		expect(faults[0].fault).toMatch(/^page 0\/0\/0 has \d+ nodes reaching past its row's box$/);
	});

	it('names rows out of order and a root without a top page', async () => {
		const { world, at } = await changed('order', ([root, leaf]) => {
			leaf.pages.reverse();
			root.pages[2].flags = 0;
		});
		const faults = (await validate(disk, world)).faults;
		expect(faults).toEqual([
			{ path: at(ROOT, '.idx'), fault: 'is a root without a top page' },
			{
				path: at(LEAF, '.idx'),
				fault: 'does not list its rows fine to coarse, in morton order within a band'
			}
		]);
	});
});

describe('probe', () => {
	/** a server of one byte file that answers ranges and sends cors, or does neither */
	async function serve(sound: boolean, run: (url: string) => Promise<void>) {
		const server = createServer((request, response) => {
			const ranged = sound && request.headers.range !== undefined;
			if (sound) response.setHeader('access-control-allow-origin', '*');
			response.writeHead(ranged ? 206 : 200).end(ranged ? 'a' : 'abc');
		});
		await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
		const { port } = server.address() as AddressInfo;
		await run(`http://127.0.0.1:${port}/a.pack`).finally(() => server.close());
	}

	it('finds no fault in a server that answers ranges and sends cors', async () => {
		await serve(true, async (url) => expect(await probe(url)).toEqual([]));
	});

	it('names a server that ignores ranges and sends no cors', async () => {
		await serve(false, async (url) => {
			expect(await probe(url)).toEqual([
				'the server answers a range request with status 200, not 206',
				'the server sends no access-control-allow-origin for another origin'
			]);
		});
	});
});
