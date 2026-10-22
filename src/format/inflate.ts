// raw deflate (rfc 1951) through the platform's compression streams

import { PREFIX, VERSION } from './spec.ts';

async function pipe(
	bytes: Uint8Array,
	stream: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
	// a blob's stream would round-trip the bytes through chrome's browser process
	const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
		start(controller) {
			controller.enqueue(bytes as Uint8Array<ArrayBuffer>);
			controller.close();
		}
	});
	const out = source.pipeThrough(stream);
	return new Uint8Array(await new Response(out).arrayBuffer());
}

export function inflate(bytes: Uint8Array): Promise<Uint8Array> {
	return pipe(bytes, new DecompressionStream('deflate-raw'));
}

export function deflate(bytes: Uint8Array): Promise<Uint8Array> {
	return pipe(bytes, new CompressionStream('deflate-raw'));
}

/** the inflated body of a file with the 8-byte magic and version prefix; throws naming the fault */
export async function unwrap(bytes: Uint8Array, magic: string, kind: string): Promise<DataView> {
	const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	if (bytes.length < PREFIX || String.fromCharCode(...bytes.subarray(0, 4)) !== magic) {
		throw new Error(`not a ${kind} file`);
	}
	const version = head.getUint16(4, true);
	if (version !== VERSION) {
		throw new Error(`${kind} version ${version}; narcissus reads ${VERSION}`);
	}
	let body: Uint8Array;
	try {
		body = await inflate(bytes.subarray(PREFIX));
	} catch {
		throw new Error(`${kind} body is not a valid deflate stream`);
	}
	return new DataView(body.buffer, body.byteOffset, body.byteLength);
}
