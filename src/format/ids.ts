import { unwrap } from './inflate.ts';
import { IDS_MAGIC } from './spec.ts';

/** the object ids of a v1 .ids, one per splat; throws an Error naming the fault */
export async function parseIds(bytes: Uint8Array): Promise<Uint16Array> {
	const v = await unwrap(bytes, IDS_MAGIC, '.ids');
	if (v.byteLength < 4) throw new Error('.ids header is cut off');
	const rows = v.getUint32(0, true);
	const size = 4 + 2 * rows;
	if (v.byteLength !== size) {
		throw new Error(`.ids holds ${v.byteLength} bytes, ${rows} rows need ${size}`);
	}
	// little-endian as every upload is; the inflated body starts its own buffer, so the view aligns
	return new Uint16Array(v.buffer, v.byteOffset + 4, rows);
}
