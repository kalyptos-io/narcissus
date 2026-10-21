#!/usr/bin/env node
// narcissus <command>: the tools over a world in a folder or on a server

import { exportWorld } from './export.ts';
import { info } from './info.ts';
import { publish } from './publish.ts';
import { validate } from './validate.ts';

const USAGE = `usage: narcissus <command>

  validate <world> [--deep]
      checks every file of a world; --deep also reads every pack whole and checks its tree
  info <world>
      what a world holds, band by band
  export <world> -o <file.ply> [--detail <m>] [--box <w,s,e,n>]
      a cut as a gaussian-splat ply: nodes of radius over m metres refined, 0 every fit splat
  publish <folder> <remote:path> [--url <world.json url>] [-- <rclone flags>]
      uploads a world with rclone, unit files first

  <world> is a folder, a world.json path or an http(s) url`;

const commands: Record<string, (args: string[]) => Promise<number>> = {
	validate,
	info,
	export: exportWorld,
	publish
};

const [name, ...args] = process.argv.slice(2);
const command = commands[name];
if (command) {
	process.exitCode = await command(args).catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	});
} else {
	console.error(USAGE);
	process.exitCode = name === undefined || name === 'help' || name === '--help' ? 0 : 1;
}
