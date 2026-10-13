import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { validate } from './validate.ts';

const USAGE =
	'usage: narcissus publish <folder> <remote:path> [--url <world.json url>] [-- <rclone flags>]';

// a unit file never changes under its name; world.json is checked with the server on each load
const UNITS = 'public, max-age=31536000, immutable';
const WORLD = 'no-cache';
/** the cache-control of the uploads, on the remotes that store headers */
const cached = (policy: string) => ['--header-upload', `Cache-Control: ${policy}`];

/** rclone with args, its output passed through; throws when it fails or is not installed */
async function rclone(args: string[]): Promise<void> {
	console.log(`rclone ${args.join(' ')}`);
	const child = spawn('rclone', args, { stdio: 'inherit' });
	// once rejects with the child's error event, which is how a missing binary shows
	const [code] = await once(child, 'exit').catch((error: NodeJS.ErrnoException) => {
		if (error.code !== 'ENOENT') throw error;
		throw new Error('rclone is not installed: https://rclone.org/install/');
	});
	if (code !== 0) throw new Error(`rclone ended with code ${code}`);
}

/** checks the folder, uploads it so that no reader meets a world.json ahead of its unit files, then checks the url */
export async function publish(args: string[]): Promise<number> {
	const cut = args.indexOf('--');
	const flags = cut < 0 ? [] : args.slice(cut + 1);
	const { values, positionals } = parseArgs({
		args: cut < 0 ? args : args.slice(0, cut),
		options: { url: { type: 'string' } },
		allowPositionals: true
	});
	if (positionals.length !== 2) throw new Error(USAGE);
	const [folder, remote] = positionals.map((path) => path.replace(/\/+$/, ''));
	if ((await validate([folder])) !== 0) return 1;
	// immutable: a unit file that is there under the same name with other bytes is an error
	await rclone(['copy', `${folder}/u`, `${remote}/u`, '--immutable', ...cached(UNITS), ...flags]);
	await rclone([
		'copyto',
		`${folder}/world.json`,
		`${remote}/world.json`,
		...cached(WORLD),
		...flags
	]);
	return values.url ? validate([values.url]) : 0;
}
