import { defineConfig } from 'vitest/config';

export default defineConfig({
	build: {
		// dist mirrors src, so each entry sits beside its declarations
		lib: {
			entry: {
				index: 'src/index.ts',
				'element/index': 'src/element/index.ts',
				'format/index': 'src/format/index.ts',
				'tools/index': 'src/tools/index.ts',
				'cli/main': 'src/cli/main.ts'
			},
			formats: ['es']
		},
		// the cli's node modules; a browser build would stub them
		rolldownOptions: { external: /^node:/ }
	},
	test: {
		expect: { requireAssertions: true },
		include: ['src/**/*.test.ts', 'bench/**/*.test.ts']
	}
});
