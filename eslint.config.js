import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

// the layers and what each may import; docs/architecture.md has the reasons
const LAYERS = {
	'src/format': [],
	'src/adapters': ['ports'],
	'src/engine': ['format', 'ports', 'adapters'],
	'src/controls': ['engine'],
	bench: ['engine', 'controls']
};
const NAMES = ['format', 'ports', 'adapters', 'engine', 'controls'];
// other layers import only the index.ts of these
const SEALED = ['engine'];

function restricted(dir, allowed) {
	return NAMES.filter((name) => name !== path.basename(dir)).flatMap((name) => {
		const group = name === 'ports' ? ['**/ports.ts'] : [`**/${name}/**`];
		if (!allowed.includes(name)) return { group, message: `${dir} does not import ${name}.` };
		if (!SEALED.includes(name)) return [];
		const message = `Import ${name} through its index.ts.`;
		return { group: [...group, `!**/${name}/index.ts`], message };
	});
}

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript checks undefined globals itself; no-undef misfires on ts
			'no-undef': 'off'
		}
	},
	...Object.entries(LAYERS).map(([dir, allowed]) => ({
		files: [`${dir}/**`],
		rules: { 'no-restricted-imports': ['error', { patterns: restricted(dir, allowed) }] }
	})),
	{
		// these run in node too
		files: ['src/format/**', 'src/ports.ts'],
		rules: { 'no-restricted-globals': ['error', 'window', 'document', 'navigator'] }
	}
);
