import type { Col } from '../types.ts';
import { unwrap } from './inflate.ts';
import { COL_CHANNELS, COL_HEADER, COL_MAGIC } from './spec.ts';

/** throws an Error naming the fault when the bytes are not a v1 .col */
export async function parseCol(bytes: Uint8Array): Promise<Col> {
	const v = await unwrap(bytes, COL_MAGIC, '.col');
	if (v.byteLength < COL_HEADER) throw new Error('.col header is cut off');
	const n = v.getUint16(0, true);
	const size = COL_HEADER + COL_CHANNELS * n * n;
	if (v.byteLength !== size) {
		throw new Error(`.col holds ${v.byteLength} bytes, ${n} nodes need ${size}`);
	}
	const values = new Float32Array(COL_CHANNELS * n * n);
	let at = COL_HEADER;
	for (let c = 0; c < COL_CHANNELS; c++) {
		const unit = v.getFloat32(12 + 4 * c, true) / 127;
		for (let j = 0; j < n; j++) {
			let q = 0;
			for (let i = 0; i < n; i++, at++) {
				q = ((q + v.getInt8(at)) << 24) >> 24;
				values[(c * n + j) * n + i] = q * unit;
			}
		}
	}
	return { n, pitch: v.getFloat32(4, true), margin: v.getFloat32(8, true), values };
}

/** the 12 channels at unit-local (x, y), bilinear between node centres, clamped to the outer nodes */
export function sampleCol(col: Col, x: number, y: number, out: Float32Array): Float32Array {
	const { n, pitch, margin, values } = col;
	const last = n - 1;
	const fx = Math.min(Math.max((x + margin) / pitch - 0.5, 0), last);
	const fy = Math.min(Math.max((y + margin) / pitch - 0.5, 0), last);
	const i0 = Math.min(Math.floor(fx), Math.max(last - 1, 0));
	const j0 = Math.min(Math.floor(fy), Math.max(last - 1, 0));
	const i1 = Math.min(i0 + 1, last);
	const j1 = Math.min(j0 + 1, last);
	const tx = fx - i0;
	const ty = fy - j0;
	const w00 = (1 - tx) * (1 - ty);
	const w10 = tx * (1 - ty);
	const w01 = (1 - tx) * ty;
	const w11 = tx * ty;
	const plane = n * n;
	for (let c = 0, base = 0; c < COL_CHANNELS; c++, base += plane) {
		out[c] =
			values[base + j0 * n + i0] * w00 +
			values[base + j0 * n + i1] * w10 +
			values[base + j1 * n + i0] * w01 +
			values[base + j1 * n + i1] * w11;
	}
	return out;
}
