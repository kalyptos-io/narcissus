import { defineConfig } from 'vitest/config';

export default defineConfig({
	build: {
		lib: { entry: { index: 'src/engine/index.ts' }, formats: ['es'] }
	},
	test: {
		expect: { requireAssertions: true },
		include: ['src/**/*.test.ts', 'bench/**/*.test.ts']
	}
});
