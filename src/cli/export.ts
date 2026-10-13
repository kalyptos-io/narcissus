import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
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
	let bytes = 0;
	const options = { level, box: box as [number, number, number, number] | undefined };
	for await (const part of exportPly(source, url, options)) {
		bytes += part.length;
		if (!file.write(part)) await once(file, 'drain');
	}
	file.end();
	await once(file, 'finish');
	console.log(`${values.out}: ${size(bytes)}`);
	return 0;
}
