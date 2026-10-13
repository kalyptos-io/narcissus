import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { contentHash } from './hash.ts';
import { parseUnitPath } from './idx.ts';

const TREE = new URL('../../fixtures/tree/', import.meta.url);

describe('contentHash', () => {
	it('gives every unit file of the fixture the hash in its name', () => {
		const files = readdirSync(new URL('u/', TREE), { recursive: true, encoding: 'utf8' })
			.map((path) => `u/${path}`)
			.filter((path) => parseUnitPath(path));
		expect(files.length).toBeGreaterThan(0);
		for (const path of files) {
			const bytes = new Uint8Array(readFileSync(new URL(path, TREE)));
			expect(contentHash(bytes), path).toBe(parseUnitPath(path)!.hash);
		}
	});
});
