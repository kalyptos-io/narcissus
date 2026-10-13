import { defineConfig } from 'vite';

const root = import.meta.dirname;

export default defineConfig({
	root,
	cacheDir: `${root}/node_modules/.vite`,
	build: {
		// an object, so a driver's single input replaces it instead of joining it
		rolldownOptions: { input: { quick: `${root}/quick.html`, drive: `${root}/drive.html` } }
	}
});
