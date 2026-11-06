// the stream worker of the benches' generated world, which nothing caches

import { openCache, serve } from './serve.ts';
import { synthetic } from './synthetic.ts';

serve(async (init) => ({
	fetch: synthetic(),
	cache: await openCache({ ...init, cache: 'none' }),
	base: init.base
}));
