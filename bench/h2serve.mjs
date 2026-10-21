// usage: node bench/h2serve.mjs <site dir> <world dir | synthetic> <cert dir> <port>; https/2 static files, the world under /world/, single closed byte ranges like the tiles worker
/** @import { AddressInfo } from 'node:net' */
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createSecureServer } from 'node:http2';
import { extname, join, normalize } from 'node:path';
import { Readable, pipeline } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
/* eslint-disable no-restricted-imports -- the server streams the synthetic world as a remote one */
import { synthetic } from '../src/engine/stream/synthetic.ts';
import { Missing } from '../src/ports.ts';
/* eslint-enable no-restricted-imports */
import { byteRange } from './range.ts';

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

// for node:http and node:http2; a link adds its rtt and bandwidth to every response; world 'synthetic' serves the generated world
/** @type {(site: string, world: string, link?: Link) => Handler} */
export const files = (site, world, link) => {
	const pace = link && throttle(link.mbps);
	const generated = world === 'synthetic' ? synthetic() : null;
	/**
	 * a body over the link, typed by the extension of name
	 * @param {any} res
	 * @param {{ status: number, name: string, stream: Readable, length: number, range: string | null, inWorld: boolean }} body
	 */
	const send = (res, { status, name, stream, length, range, inWorld }) => {
		res.writeHead(status, {
			'content-type': types[extname(name)] ?? 'application/octet-stream',
			'content-length': length,
			'cache-control': 'no-store',
			// the app bench's site fetches the world from another port
			'access-control-allow-origin': '*',
			...(range && { 'content-range': range })
		});
		// worker fetches miss the page's resource timing, so world bytes are logged here
		/** @param {unknown} error */
		const done = (error) => {
			if (!error && inWorld) link?.served.push([Date.now(), length]);
		};
		if (pace) pipeline(stream, pace, res, done);
		else pipeline(stream, res, done);
	};
	return async (req, res) => {
		const path = decodeURIComponent(new URL(req.url ?? '/', 'https://local').pathname);
		const inWorld = path.startsWith('/world/');
		const range = byteRange(req.headers.range ?? null);
		if (inWorld && generated) {
			const bytes = await generate(generated, path.slice(7), range);
			if (link) await sleep(link.rttMs);
			if (!bytes) {
				res.writeHead(404);
				return res.end();
			}
			return send(res, {
				status: range ? 206 : 200,
				name: path,
				stream: Readable.from([Buffer.from(bytes)]),
				length: bytes.length,
				// the generator does not know a pack's size without building it, and the engine reads none
				range: range && `bytes ${range[0]}-${range[1]}/*`,
				inWorld
			});
		}
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
		const [start, end] = range ? [range[0], Math.min(range[1], size - 1)] : [0, size - 1];
		if (range && start > end) {
			res.writeHead(416, { 'content-range': `bytes */${size}` });
			return res.end();
		}
		send(res, {
			status: range ? 206 : 200,
			name: file,
			stream: createReadStream(file, range ? { start, end } : undefined),
			length: end - start + 1,
			range: range && `bytes ${start}-${end}/${size}`,
			inWorld
		});
	};
};

/**
 * a file of the synthetic world, a range of it as the engine asks: whole pages only; undefined when missing
 * @param {import('../src/ports.ts').Fetch} generated
 * @param {string} path
 * @param {[number, number] | null} range
 */
async function generate(generated, path, range) {
	try {
		return await generated(`synthetic/${path}`, range && [range[0], range[1] + 1]);
	} catch (error) {
		if (!(error instanceof Missing)) throw error;
	}
}

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
