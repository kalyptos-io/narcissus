import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { disk } from '../adapters/disk.ts';
import { http } from '../adapters/http.ts';
import type { Fetch } from '../ports.ts';

const REMOTE = /^https?:\/\//;

/** the source and world.json url of a world named by a url, a folder or a world.json path */
export function target(world: string): { source: Fetch; url: string; remote: boolean } {
	if (REMOTE.test(world)) {
		return { source: http, url: world.endsWith('/') ? `${world}world.json` : world, remote: true };
	}
	// forward slashes: a world's directory is cut at them, and windows reads them too
	const path = resolve(world).replaceAll('\\', '/');
	const folder = statSync(path, { throwIfNoEntry: false })?.isDirectory();
	return { source: disk, url: folder ? `${path}/world.json` : path, remote: false };
}

export function size(bytes: number): string {
	const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB'];
	const k = Math.min(units.length - 1, Math.floor(Math.log2(Math.max(bytes, 1)) / 10));
	return `${k === 0 ? bytes : (bytes / 2 ** (10 * k)).toFixed(1)} ${units[k]}`;
}
