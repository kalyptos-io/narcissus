import { describe, expect, it } from 'vitest';
import { Missing } from '../ports.ts';
import { files } from './files.ts';

const fetch = files(new Map([['u/a.pack', new Blob([new Uint8Array([0, 1, 2, 3, 4, 5])])]]));

describe('files', () => {
	it('reads a whole file and a range of it by path', async () => {
		expect([...(await fetch('u/a.pack', null))]).toEqual([0, 1, 2, 3, 4, 5]);
		expect([...(await fetch('u/a.pack', [2, 5]))]).toEqual([2, 3, 4]);
	});

	it('rejects a path it does not hold with Missing', async () => {
		await expect(fetch('u/b.pack', null)).rejects.toBeInstanceOf(Missing);
	});
});
