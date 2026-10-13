// usage: node bench/h2serve.mjs <site dir> <world dir> <cert dir> <port>; https/2 static files, the world under /world/, single closed byte ranges like the tiles worker
/** @import { AddressInfo } from 'node:net' */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createSecureServer } from 'node:http2';
import { extname, join, normalize } from 'node:path';
import { pipeline } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { byteRange } from '../src/lib/range.ts';

/** @typedef {{ rttMs: number, mbps: number, served: [number, number][] }} Link */
/** @typedef {(req: { url?: string, headers: { range?: string } }, res: any) => unknown} Handler */

/** @type {Record<string, string>} */
const types = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.json': 'application/json'
};

/** @param {number} mbps megabytes per second */
function throttle(mbps) {
	// one link for every response, so concurrent ones share its bandwidth
	let free = 0;
	/** @param {AsyncIterable<Buffer>} chunks */
	async function* pace(chunks) {
		for await (const chunk of chunks) {
			const now = performance.now();
			free = Math.max(free, now) + chunk.length / (mbps * 1e3);
			await sleep(free - now);
			yield chunk;
		}
	}
	return pace;
}

// for node:http and node:http2; a link adds its rtt and bandwidth to every response
/** @type {(site: string, world: string, link?: Link) => Handler} */
export const files = (site, world, link) => {
	const pace = link && throttle(link.mbps);
	return async (req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? '/', 'https://local').pathname);
		const inWorld = path.startsWith('/world/');
		const [root, rest] = inWorld ? [world, path.slice(6)] : [site, path];
		// a leading slash keeps normalize from climbing out of the root
		const file = join(root, normalize(rest));
		let stat;
		try {
			stat = statSync(file);
		} catch {
			// missing, or a path through a file
		}
		if (link) await sleep(link.rttMs);
		if (!stat?.isFile()) {
			res.writeHead(404);
			return res.end();
		}
		const { size } = stat;
		const range = byteRange(req.headers.range ?? null);
		const [start, end] = range ? [range[0], Math.min(range[1], size - 1)] : [0, size - 1];
		if (range && start > end) {
			res.writeHead(416, { 'content-range': `bytes */${size}` });
			return res.end();
		}
		const length = end - start + 1;
		res.writeHead(range ? 206 : 200, {
			'content-type': types[extname(file)] ?? 'application/octet-stream',
			'content-length': length,
			'cache-control': 'no-store',
			// the app bench's site fetches the world from another port
			'access-control-allow-origin': '*',
			...(range && { 'content-range': `bytes ${start}-${end}/${size}` })
		});
		const stream = createReadStream(file, range ? { start, end } : undefined);
		// worker fetches miss the page's resource timing, so world bytes are logged here
		/** @param {unknown} error */
		const done = (error) => {
			if (!error && inWorld) link?.served.push([Date.now(), length]);
		};
		if (pace) pipeline(stream, pace, res, done);
		else pipeline(stream, res, done);
	};
};

/**
 * listens on 127.0.0.1; port 0 picks a free one, read back from server.address()
 * @param {string} site
 * @param {string} world
 * @param {string} certs
 * @param {number} port
 * @param {Link} [link]
 */
export async function serve(site, world, certs, port, link) {
	const key = join(certs, 'key.pem');
	const cert = join(certs, 'cert.pem');
	if (!existsSync(key) || !existsSync(cert)) {
		mkdirSync(certs, { recursive: true });
		// the browser runs with --ignore-certificate-errors, so expiry never matters
		execFileSync(
			'openssl',
			// prettier-ignore
			['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
				'-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=127.0.0.1',
				'-addext', 'subjectAltName=IP:127.0.0.1'],
			{ stdio: 'ignore' }
		);
	}
	const server = createSecureServer(
		{ key: readFileSync(key), cert: readFileSync(cert) },
		files(site, world, link)
	);
	await new Promise((resolve, reject) =>
		server.once('error', reject).listen(port, '127.0.0.1', () => resolve(undefined))
	);
	return server;
}

if (import.meta.main) {
	const [site, world, certs, port] = process.argv.slice(2);
	const server = await serve(site, world, certs, +port);
	const address = /** @type {AddressInfo} */ (server.address());
	console.log(`https://127.0.0.1:${address.port}/`);
}
