import { describe, expect, it } from 'vitest';
import { shardOf } from './loader.ts';

const packs: string[] = [];
for (let k = 0; k < 400; k++) {
	const e = 724000 + 250 * (k % 20);
	const n = 6177000 + 250 * Math.floor(k / 20);
	packs.push(`u/0/${e}/${n}.${k.toString(16).padStart(16, '0')}.pack`);
}

describe('shardOf', () => {
	it('sends a pack to the same worker every time, within the pool', () => {
		for (const pack of packs) {
			const shard = shardOf(pack, 6);
			expect(shard).toBe(shardOf(pack, 6));
			expect(shard).toBeGreaterThanOrEqual(0);
			expect(shard).toBeLessThan(6);
			expect(Number.isInteger(shard)).toBe(true);
		}
	});

	it('spreads the packs of a region over all workers', () => {
		const counts = new Array<number>(6).fill(0);
		for (const pack of packs) counts[shardOf(pack, 6)]++;
		expect(Math.min(...counts)).toBeGreaterThan(400 / 6 / 3);
	});

	it('puts everything on worker 0 of one', () => {
		expect(packs.every((pack) => shardOf(pack, 1) === 0)).toBe(true);
	});
});
