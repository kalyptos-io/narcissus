import type { Cache } from '../ports.ts';

/**
 * a Cache in the origin private file system, least recently used first past bytes; null when the
 * browser offers none (private windows); every failure inside is a miss, never an error.
 * shard k keeps its files in cache/k and must be their only user.
 */
export async function opfsCache(bytes: number, shard: number): Promise<Cache | null> {
	let dir: FileSystemDirectoryHandle;
	try {
		const root = await cacheRoot();
		dir = await root.getDirectoryHandle(String(shard), { create: true });
	} catch {
		return null;
	}

	// file name to size, oldest use first
	const index = new Map<string, number>();
	let total = 0;
	let scanned = false;
	const touch = (name: string, size: number) => {
		total += size - (index.get(name) ?? 0);
		index.delete(name);
		index.set(name, size);
	};
	const forget = (name: string) => {
		total -= index.get(name) ?? 0;
		index.delete(name);
	};
	const evict = () => {
		if (!scanned) return;
		for (const [name, size] of index) {
			if (total <= bytes) break;
			index.delete(name);
			total -= size;
			void dir.removeEntry(name).catch(() => undefined);
		}
	};

	// files of earlier sessions count as older than any used since start
	void scan(dir).then((found) => {
		const recent = [...index];
		index.clear();
		total = 0;
		for (const { name, size } of found.sort((a, b) => a.time - b.time)) touch(name, size);
		for (const [name, size] of recent) touch(name, size);
		scanned = true;
		evict();
	});

	return {
		async get(key) {
			const name = encodeURIComponent(key);
			// the shard is the directory's only user, so a scanned index lists every file
			if (scanned && !index.has(name)) return undefined;
			const value = await read(dir, name);
			if (value) touch(name, value.length);
			else forget(name);
			return value;
		},
		async put(key, value) {
			if (value.length === 0 || value.length > bytes) return;
			const name = encodeURIComponent(key);
			if (!(await write(dir, name, value))) return;
			touch(name, value.length);
			evict();
		}
	};
}

/** removes everything in cache/ but the directories of shards 0 to shards - 1; never fails */
export async function pruneOpfs(shards: number): Promise<void> {
	const kept = new Set(Array.from({ length: shards }, (_, k) => String(k)));
	try {
		const dir = await cacheRoot();
		const stale: string[] = [];
		for await (const [name, handle] of dir.entries()) {
			if (handle.kind !== 'directory' || !kept.has(name)) stale.push(name);
		}
		const recursive = { recursive: true };
		for (const name of stale) await dir.removeEntry(name, recursive).catch(() => undefined);
	} catch {
		// whatever stays is pruned on a later start
	}
}

async function cacheRoot() {
	return (await navigator.storage.getDirectory()).getDirectoryHandle('cache', { create: true });
}

async function read(dir: FileSystemDirectoryHandle, name: string) {
	try {
		const file = await (await dir.getFileHandle(name)).getFile();
		// a file mid-write or left by a failed write is empty
		return file.size > 0 ? new Uint8Array(await file.arrayBuffer()) : undefined;
	} catch {
		return undefined;
	}
}

async function write(dir: FileSystemDirectoryHandle, name: string, value: Uint8Array) {
	let stream: FileSystemWritableFileStream | undefined;
	try {
		stream = await (await dir.getFileHandle(name, { create: true })).createWritable();
		await stream.write(value as Uint8Array<ArrayBuffer>);
		await stream.close();
		return true;
	} catch {
		void stream?.abort().catch(() => undefined);
		return false;
	}
}

async function scan(dir: FileSystemDirectoryHandle) {
	const found: { name: string; size: number; time: number }[] = [];
	try {
		for await (const [name, handle] of dir.entries()) {
			if (handle.kind !== 'file') continue;
			const file = await handle.getFile().catch(() => null);
			if (file) found.push({ name, size: file.size, time: file.lastModified });
		}
	} catch {
		// a partial scan still bounds the cache
	}
	return found;
}
