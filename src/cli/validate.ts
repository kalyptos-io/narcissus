import { parseArgs } from 'node:util';
import { validate as check } from '../tools/index.ts';
import { size, target } from './shared.ts';

export async function validate(args: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args,
		options: { deep: { type: 'boolean', default: false } },
		allowPositionals: true
	});
	if (positionals.length !== 1) throw new Error('usage: narcissus validate <world> [--deep]');
	const { source, url, remote } = target(positionals[0]);
	const live = process.stderr.isTTY;
	const report = await check(source, url, {
		deep: values.deep,
		server: remote,
		progress: live ? ({ units }) => process.stderr.write(`\r${units} units`) : undefined
	});
	if (live) process.stderr.write('\r\x1b[K');
	for (const { path, fault } of report.faults) console.log(`${path}: ${fault}`);
	const faults = report.faults.length;
	const found = faults === 0 ? 'no faults' : `${faults} ${faults === 1 ? 'fault' : 'faults'}`;
	console.log(`${report.units} units, ${report.files} files, ${size(report.bytes)}: ${found}`);
	return faults === 0 ? 0 : 1;
}
