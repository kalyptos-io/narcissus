import { describe, expect, it } from 'vitest';
import { memoryCache } from './memory.ts';

const bytes = (length: number) => new Uint8Array(length);

describe('memoryCache', () => {
	it('returns what was put and misses what was not', async () => {
		const cache = memoryCache(100);
		await cache.put('a', bytes(10));
		expect(await cache.get('a')).toEqual(bytes(10));
		expect(await cache.get('b')).toBeUndefined();
	});

	it('drops the least recently used entries past its bytes', async () => {
		const cache = memoryCache(30);
		await cache.put('a', bytes(10));
		await cache.put('b', bytes(10));
		await cache.put('c', bytes(10));
		await cache.get('a');
		await cache.put('d', bytes(10));
		expect(await cache.get('b')).toBeUndefined();
		expect(await cache.get('a')).toBeDefined();
		expect(await cache.get('c')).toBeDefined();
		expect(await cache.get('d')).toBeDefined();
	});

	it('counts a replaced entry once', async () => {
		const cache = memoryCache(30);
		await cache.put('a', bytes(10));
		await cache.put('b', bytes(10));
		await cache.put('a', bytes(20));
		expect(await cache.get('a')).toHaveLength(20);
		expect(await cache.get('b')).toBeDefined();
	});

	it('keeps nothing larger than its bytes and evicts nothing for it', async () => {
		const cache = memoryCache(30);
		await cache.put('a', bytes(10));
		await cache.put('big', bytes(31));
		expect(await cache.get('big')).toBeUndefined();
		expect(await cache.get('a')).toBeDefined();
	});
});
