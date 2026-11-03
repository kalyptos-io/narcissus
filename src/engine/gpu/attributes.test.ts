import { describe, expect, it } from 'vitest';
import {
	chunkWords,
	readRecords,
	readValues,
	CLUSTER,
	COLOUR_WORDS,
	ENCODING,
	GEOMETRY_WORDS,
	PAGE_PARAMS,
	type Attribute,
	type DecodedPage,
	type PageAttribute,
	type Scalar
} from '../../format/index.ts';
import { encodeChunk, mulberry32 } from '../../format/encode.ts';
import attributes from './attributes.wgsl?raw';
import { bufferLayout } from './buffers.ts';
import { CLUSTER_WORDS } from './layout.ts';
import common from './common.wgsl?raw';
import records from './records.wgsl?raw';
import { widen } from '../stream/attributes.ts';
import { Pool } from './pool.ts';
import { readBuffer, testDevice } from './test-device.ts';

const ROWS = 300;
const { plain, dictionary, sparse } = ENCODING;
/** query.w of a record's word i, its f16 pair at word i, and its length */
const WORD = 0x100;
const F16X2 = 0x200;
const LENGTH = 0x300;

const KERNEL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> pages: array<Page>;
@group(0) @binding(1) var<storage, read> extension: array<u32>;
@group(0) @binding(2) var<storage, read> queries: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> out: array<vec2u>;

@compute @workgroup_size(64)
fn probe(@builtin(global_invocation_id) id: vec3u) {
	if (id.x >= arrayLength(&queries)) {
		return;
	}
	let q = queries[id.x];
	if (q.w < ${WORD}u) {
		out[id.x] = vec2u(attribute_word(q.x, q.y, q.z, q.w), 0u);
		return;
	}
	let r = attribute_record(q.x, q.y, q.z);
	if (q.w >= ${LENGTH}u) {
		out[id.x] = vec2u(r.words, 0u);
	} else if (q.w >= ${F16X2}u) {
		out[id.x] = bitcast<vec2u>(record_f16x2(r, q.w - ${F16X2}u));
	} else {
		out[id.x] = vec2u(record_u32(r, q.w - ${WORD}u), 0u);
	}
}`;

interface Stream {
	id: number;
	a: Attribute;
	encoding: number;
	body: Uint8Array;
}

const fixed = (type: Scalar, components: number, ...value: number[]): Attribute => ({
	type,
	components,
	default: value.length ? value : Array(components).fill(0),
	rule: 'preserved'
});
const RECORDS: Attribute = { type: 'records', components: 0, default: [], rule: 'preserved' };

function page(attributes?: PageAttribute[]): DecodedPage {
	return {
		count: ROWS,
		quadrants: [ROWS, ROWS, ROWS],
		geometry: new Uint32Array(ROWS * GEOMETRY_WORDS),
		colour: new Uint32Array(ROWS * COLOUR_WORDS),
		params: new Float32Array(PAGE_PARAMS),
		clusters: new Float32Array(Math.ceil(ROWS / CLUSTER) * 6),
		attributes
	};
}

/** a stream of each encoding and shape, with engine ids that leave a gap */
function streams(): Stream[] {
	const next = mulberry32(7);
	const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
	const values = <T>(n: number, draw: () => T) => Array.from({ length: n }, draw);
	const record = () =>
		next() < 0.4 ? Uint8Array.from(values(int(1, 9), () => int(0, 255))) : new Uint8Array(0);
	const made: [number, Attribute, number, ArrayLike<number> | Uint8Array[]][] = [
		[0, fixed('u8', 3), plain, values(3 * ROWS, () => int(0, 255))],
		[1, fixed('u16', 1), dictionary, values(ROWS, () => int(0, 65535))],
		[
			2,
			fixed('i16', 2, -7, 3),
			sparse,
			values(ROWS, () => (next() < 0.7 ? [-7, 3] : [int(-32768, 32767), int(-32768, 32767)])).flat()
		],
		[3, fixed('f16', 2), plain, values(2 * ROWS, () => int(-4096, 4096) / 64)],
		[4, fixed('f32', 1), dictionary, values(ROWS, () => [0.25, -1e9, 3.5][int(0, 2)])],
		[5, RECORDS, plain, values(ROWS, record)],
		[6, RECORDS, sparse, values(ROWS, record)],
		[7, fixed('i8', 1), dictionary, values(ROWS, () => int(-128, 127))],
		[9, fixed('u32', 1, 4000000000), plain, values(ROWS, () => int(0, 2 ** 32 - 1))]
	];
	return made.map(([id, a, encoding, v]) => ({
		id,
		a,
		encoding,
		body: encodeChunk(v, a, encoding)
	}));
}

describe('attributes.wgsl', () => {
	it('reads every encoding of a page back as written, and defaults where a page has none', async () => {
		const device = await testDevice();
		const pool = new Pool(device, 4 * CLUSTER);
		const all = streams();
		// stream 9 is left off the page: its rows take the default
		const held = all.filter((s) => s.id !== 9);
		const pageAttributes = held.map(({ id, a, encoding, body }) => ({
			stream: id,
			...chunkWords(body, { encoding, rows: ROWS }, a)
		}));
		pool.add(1, page(pageAttributes), [0, 0], () => false);
		pool.add(2, page(), [0, 0], () => false);
		pool.upload(Infinity);
		pool.draw([]);
		for (const { id, a } of all) {
			const words = Uint32Array.from({ length: 4 }, (_, c) =>
				a.type === 'records' || c >= a.components ? 0 : widen(a.type, a.default[c])
			);
			pool.extension.write(4 * id, words);
		}
		pool.extension.flush();

		const clusters = new Uint32Array(await readBuffer(device, pool.clusters));
		// the first page takes slots 0 and 1, the second slot 2
		const [first, second] = [clusters[0], clusters[2 * CLUSTER_WORDS]];
		const queries: number[] = [];
		const want: number[] = [];
		const ask = (p: number, row: number, stream: number, w: number, x: number, y = 0) => {
			queries.push(p, row, stream, w);
			want.push(x, y);
		};
		for (const { id, a, encoding, body } of all) {
			const onPage = id !== 9;
			if (a.type === 'records') {
				const records = readRecords(body, { encoding, rows: ROWS }, a);
				for (let row = 0; row < ROWS; row++) {
					const padded = new Uint32Array(Math.ceil(records[row].length / 4));
					new Uint8Array(padded.buffer).set(records[row]);
					ask(first, row, id, LENGTH, padded.length);
					ask(second, row, id, LENGTH, 0);
					for (let i = 0; i <= padded.length; i++) ask(first, row, id, WORD + i, padded[i] ?? 0);
					if (padded.length) {
						const pair = Float32Array.from(new Float16Array(padded.buffer, 0, 2));
						const bits = new Uint32Array(pair.buffer);
						ask(first, row, id, F16X2, bits[0], bits[1]);
					}
				}
				continue;
			}
			const values = onPage
				? readValues(body, { encoding, rows: ROWS }, a)
				: Float64Array.from({ length: ROWS * a.components }, (_, k) => a.default[k % a.components]);
			for (let row = 0; row < ROWS; row++) {
				for (let c = 0; c < a.components; c++) {
					ask(first, row, id, c, widen(a.type, values[row * a.components + c]));
					ask(second, row, id, c, widen(a.type, a.default[c]));
				}
			}
		}
		// an id past every directory reads its default
		ask(first, 0, 12, 0, 0);

		const queryBuffer = device.createBuffer({
			size: queries.length * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
		});
		device.queue.writeBuffer(queryBuffer, 0, Uint32Array.from(queries));
		const out = device.createBuffer({
			size: want.length * 4,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
		});
		const layout = bufferLayout(device, 'attributes test', GPUShaderStage.COMPUTE, [
			'read-only-storage',
			'read-only-storage',
			'read-only-storage',
			'storage'
		]);
		const module = device.createShaderModule({
			code: `${common}\n${records}\n${attributes}\n${KERNEL}`
		});
		const pipeline = device.createComputePipeline({
			layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
			compute: { module, entryPoint: 'probe' }
		});
		const group = device.createBindGroup({
			layout,
			entries: [pool.pages, pool.extension.buffer, queryBuffer, out].map((buffer, binding) => ({
				binding,
				resource: { buffer }
			}))
		});
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginComputePass();
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, group);
		pass.dispatchWorkgroups(Math.ceil(queries.length / 4 / 64));
		pass.end();
		device.queue.submit([encoder.finish()]);
		const got = new Uint32Array(await readBuffer(device, out));
		const nan = (bits: number) => Number.isNaN(new Float32Array(Uint32Array.of(bits).buffer)[0]);
		const wrong: string[] = [];
		for (let k = 0; k < want.length; k++) {
			const [p, row, stream, w] = queries.slice(4 * (k >> 1), 4 * (k >> 1) + 4);
			// a gpu gives the nans of an f16 pair its own payload
			const f16 = w >= F16X2 && w < LENGTH;
			if (got[k] !== want[k] >>> 0 && !(f16 && nan(got[k]) && nan(want[k]))) {
				wrong.push(`page ${p} row ${row} stream ${stream} w ${w}: ${got[k]} not ${want[k]}`);
			}
		}
		expect(wrong.slice(0, 10)).toEqual([]);
		queryBuffer.destroy();
		out.destroy();
		pool.destroy();
	});
});
