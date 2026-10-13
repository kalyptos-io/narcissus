import type { Cache } from '../ports.ts';

/** least recently used entries go first once bytes are exceeded */
export function memoryCache(bytes: number): Cache {
	// map order is use order, oldest first
	const entries = new Map<string, Uint8Array>();
	let total = 0;
	return {
		async get(key) {
			const hit = entries.get(key);
			if (hit) {
				entries.delete(key);
				entries.set(key, hit);
			}
			return hit;
		},
		async put(key, value) {
			const old = entries.get(key);
			if (old) {
				entries.delete(key);
				total -= old.length;
			}
			if (value.length > bytes) return;
			entries.set(key, value);
			total += value.length;
			for (const [oldest, evicted] of entries) {
				if (total <= bytes) break;
				entries.delete(oldest);
				total -= evicted.length;
			}
		}
	};
}
