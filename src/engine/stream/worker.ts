// the stream worker over http or the page's own Fetch

import { http } from '../../adapters/http.ts';
import { openCache, serve } from './serve.ts';

serve(async (init, page) => ({
	fetch: init.source === 'page' ? page : http,
	cache: await openCache(init)
}));
