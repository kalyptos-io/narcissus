import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

// the layers and what each may import; docs/architecture.md has the reasons
const LAYERS = {
	'src/format': [],
	'src/adapters': ['ports'],
	'src/tools': ['format', 'ports'],
	'src/engine': ['format', 'ports', 'adapters'],
	'src/controls': ['engine'],
	'src/element': ['engine', 'controls'],
	'src/cli': ['format', 'ports', 'adapters', 'tools'],
	bench: []
};
const NAMES = ['format', 'ports', 'adapters', 'tools', 'engine', 'controls', 'element', 'cli'];
// the modules of a layer that other layers may import; a layer not named here is open
const PUBLIC = {
	format: ['index.ts', 'encode.ts'],
	tools: ['index.ts'],
	engine: ['index.ts'],
	controls: ['index.ts']
};
// a test may drive its layer through the ports and their adapters
const TESTS = ['ports', 'adapters'];

function restricted(dir, allowed) {
	return NAMES.filter((name) => name !== path.basename(dir)).flatMap((name) => {
		const group = name === 'ports' ? ['**/ports.ts'] : [`**/${name}/**`];
		if (!allowed.includes(name)) return { group, message: `${dir} does not import ${name}.` };
		const open = PUBLIC[name];
		if (!open) return [];
		const message = `Import ${name} through its ${open.join(' or ')}.`;
		return { group: [...group, ...open.map((file) => `!**/${name}/${file}`)], message };
	});
}

const rule = (patterns) => ({ 'no-restricted-imports': ['error', { patterns }] });

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	prettier,
	// tsc checks undefined names, in the bench's js through checkJs
	{ rules: { 'no-undef': 'off' } },
	...Object.entries(LAYERS).flatMap(([dir, allowed]) => [
		{ files: [`${dir}/**`], rules: rule(restricted(dir, allowed)) },
		{ files: [`${dir}/**/*.test.ts`], rules: rule(restricted(dir, [...allowed, ...TESTS])) }
	]),
	{
		// these run in node too
		files: ['src/format/**', 'src/tools/**', 'src/ports.ts'],
		rules: { 'no-restricted-globals': ['error', 'window', 'document', 'navigator'] }
	}
);
