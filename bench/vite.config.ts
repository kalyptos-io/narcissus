import { defineConfig } from 'vite';

const root = import.meta.dirname;

export default defineConfig({
	root,
	cacheDir: `${root}/node_modules/.vite`
});
