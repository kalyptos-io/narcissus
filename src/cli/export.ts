import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { exportPly } from '../tools/index.ts';
import { size, target } from './shared.ts';

const USAGE = 'usage: narcissus export <world> -o <file.ply> [--level <g>] [--box <w,s,e,n>]';

export async function exportWorld(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: {
			out: { type: 'string', short: 'o' },
			level: { type: 'string', default: '0' },
			box: { type: 'string' }
		},
		allowPositionals: true
	});
	const level = Number(values.level);
	const box = values.box?.split(',').map(Number);
	const sound =
		Number.isInteger(level) &&
		level >= 0 &&
		(!box || (box.length === 4 && box.every(Number.isFinite)));
	if (positionals.length !== 1 || !values.out || !sound) throw new Error(USAGE);
	const { source, url } = target(positionals[0]);
	const file = createWriteStream(values.out);
	const options = { level, box: box as [number, number, number, number] | undefined };
	await pipeline(exportPly(source, url, options), file);
	console.log(`${values.out}: ${size(file.bytesWritten)}`);
	return 0;
}
