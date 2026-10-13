import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { disk } from '../adapters/disk.ts';
import { probe, validate } from './validate.ts';

const TREE = fileURLToPath(new URL('../../fixtures/tree', import.meta.url));
const LEAF = 'u/0/723000/6177000';
const PACK = `${LEAF}.656598a8e97f00d8.pack`;
const COL = `${LEAF}.89b517b3bc33d6bb.col`;
const FILES = [
	`${LEAF}.2e01b7ffcdd8552f.idx`,
	PACK,
	COL,
	'u/0/723250/6177000.22bd82e562f085dd.idx',
	'u/0/723250/6177000.cdfa006742dda297.pack',
	'u/1/723000/6177000.b1634a664db0fb6f.pack',
	'u/1/723000/6177000.c434e29875e6dc79.idx'
];

const scratch = mkdtempSync(join(tmpdir(), 'narcissus-'));
afterAll(() => rmSync(scratch, { recursive: true }));

/** a copy of the fixture with change made to it */
function copy(name: string, change: (dir: string) => void): string {
	const dir = join(scratch, name);
	cpSync(TREE, dir, { recursive: true });
	change(dir);
	return `${dir}/world.json`;
}

describe('validate', () => {
	it('finds no fault in the fixture, deep or not', async () => {
		const bytes = FILES.reduce((sum, path) => sum + statSync(join(TREE, path)).size, 0);
		for (const deep of [false, true]) {
			const report = await validate(disk, `${TREE}/world.json`, { deep });
			expect(report).toEqual({ units: 3, files: 7, bytes, faults: [] });
		}
	});

	it('names a missing file', async () => {
		const world = copy('missing', (dir) => rmSync(join(dir, COL)));
		const { faults } = await validate(disk, world);
		expect(faults).toEqual([{ path: COL, fault: 'is missing' }]);
	});

	it('names a pack that is cut short', async () => {
		const world = copy('short', (dir) => {
			const file = join(dir, PACK);
			writeFileSync(file, readFileSync(file).subarray(0, -10));
		});
		const { faults } = await validate(disk, world);
		expect(faults.map((f) => f.path)).toEqual([PACK]);
	});

	it('names a pack with one byte changed, when deep', async () => {
		const world = copy('flipped', (dir) => {
			const file = join(dir, PACK);
			const bytes = readFileSync(file);
			bytes[100] ^= 1;
			writeFileSync(file, bytes);
		});
		expect((await validate(disk, world)).faults).toEqual([]);
		const { faults } = await validate(disk, world, { deep: true });
		expect(faults).toContainEqual({ path: PACK, fault: 'does not have the hash in its name' });
		expect(new Set(faults.map((f) => f.path))).toEqual(new Set([PACK]));
	});

	it('reports a world.json that does not parse and goes no further', async () => {
		const world = copy('unreadable', (dir) => writeFileSync(join(dir, 'world.json'), '{}'));
		const report = await validate(disk, world);
		expect(report.units).toBe(0);
		expect(report.faults).toEqual([
			{ path: 'world.json', fault: 'This world is version undefined; narcissus reads 1.' }
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
