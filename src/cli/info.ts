import { parseArgs } from 'node:util';
import { info as read } from '../tools/index.ts';
import { size, target } from './shared.ts';

export async function info(args: string[]): Promise<number> {
	const { positionals } = parseArgs({ args, allowPositionals: true });
	if (positionals.length !== 1) throw new Error('usage: narcissus info <world>');
	const { source, url } = target(positionals[0]);
	const { world, units, levels, bytes } = await read(source, url);
	const { e, n, h } = world.extent;
	const count = (value: number) => value.toLocaleString('en-US');
	console.log(`version  ${world.version}`);
	console.log(`crs      ${world.crs}, heights in ${world.height}`);
	console.log(`extent   e ${e[0]} to ${e[1]}, n ${n[0]} to ${n[1]}, h ${h[0]} to ${h[1]}`);
	console.log(`roots    ${world.roots.length}`);
	console.log(`packs    ${size(bytes)}`);
	units.forEach((found, level) => console.log(`units    level ${level}: ${count(found)}`));
	levels.forEach(({ pages, splats }, g) => {
		console.log(`splats   level ${g}: ${count(splats)} in ${count(pages)} pages`);
	});
	return 0;
}
