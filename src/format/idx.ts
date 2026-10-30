import type { Idx, PageRow, UnitKey } from './types.ts';
import { unwrap } from './inflate.ts';
import {
	CHILD_BYTES,
	DESCENDANT_BYTES,
	IDX_HEADER,
	IDX_MAGIC,
	LEAF,
	PACK_MAGIC,
	PACK_TRAILER,
	ROW_BYTES,
	VERSION
} from './spec.ts';

function hashAt(view: DataView, offset: number): string {
	let hex = '';
	for (let b = 0; b < 8; b++) {
		const byte = view.getUint8(offset + b);
		hex += byte.toString(16).padStart(2, '0');
	}
	return hex;
}

/** a 52-byte page row at offset, as in .idx and the .pack table */
export function rowAt(view: DataView, offset: number): PageRow {
	const box = new Float32Array(6);
	for (let k = 0; k < 6; k++) box[k] = view.getFloat32(offset + 20 + 4 * k, true);
	return {
		g: view.getUint8(offset),
		i: view.getUint8(offset + 1),
		j: view.getUint8(offset + 2),
		count: view.getUint32(offset + 4, true),
		quadrants: [
			view.getUint32(offset + 8, true),
			view.getUint32(offset + 12, true),
			view.getUint32(offset + 16, true)
		],
		box,
		offset: view.getUint32(offset + 44, true),
		length: view.getUint32(offset + 48, true)
	};
}

/** the rows of a pack's page table, through read(start, end) of a pack of size bytes; throws naming the fault */
export async function packRows(
	read: (start: number, end: number) => Promise<Uint8Array>,
	size: number
): Promise<PageRow[]> {
	if (size < PACK_TRAILER) throw new Error('is shorter than a pack trailer');
	const trailer = await read(size - PACK_TRAILER, size);
	const view = new DataView(trailer.buffer, trailer.byteOffset, trailer.byteLength);
	if (String.fromCharCode(...trailer.subarray(8, 12)) !== PACK_MAGIC) {
		throw new Error('does not end in a pack trailer');
	}
	const version = view.getUint16(12, true);
	if (version !== VERSION) throw new Error(`is version ${version}; narcissus reads ${VERSION}`);
	const offset = view.getUint32(0, true);
	const rows = view.getUint32(4, true);
	if (offset + rows * ROW_BYTES !== size - PACK_TRAILER) {
		throw new Error('has a page table that does not end at its trailer');
	}
	const bytes = await read(offset, size - PACK_TRAILER);
	const table = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return Array.from({ length: rows }, (_, r) => rowAt(table, r * ROW_BYTES));
}

/** throws an Error naming the fault when the bytes are not a v1 .idx */
export async function parseIdx(bytes: Uint8Array): Promise<Idx> {
	const v = await unwrap(bytes, IDX_MAGIC, '.idx');
	if (v.byteLength < IDX_HEADER) throw new Error('.idx header is cut off');
	const rows = v.getUint16(32, true);
	const children = v.getUint8(34);
	const descendants = v.getUint16(36, true);
	const size =
		IDX_HEADER + rows * ROW_BYTES + children * CHILD_BYTES + descendants * DESCENDANT_BYTES;
	if (v.byteLength !== size) {
		throw new Error(`.idx holds ${v.byteLength} bytes, its counts need ${size}`);
	}
	const colHash = hashAt(v, 24);
	const idx: Idx = {
		level: v.getUint8(0),
		e: v.getInt32(4, true),
		n: v.getInt32(8, true),
		pack: hashAt(v, 12),
		packSize: v.getUint32(20, true),
		col: colHash === '0000000000000000' ? null : colHash,
		rows: [],
		children: [],
		descendants: []
	};
	let at = IDX_HEADER;
	for (let r = 0; r < rows; r++, at += ROW_BYTES) idx.rows.push(rowAt(v, at));
	for (let c = 0; c < children; c++, at += CHILD_BYTES) {
		idx.children.push({ quadrant: v.getUint8(at), idx: hashAt(v, at + 1) });
	}
	for (let d = 0; d < descendants; d++, at += DESCENDANT_BYTES) {
		idx.descendants.push({
			depth: v.getUint8(at),
			column: v.getUint8(at + 1),
			row: v.getUint8(at + 2),
			idx: hashAt(v, at + 3)
		});
	}
	return idx;
}

/** u/<L>/<E>/<N>.<hash>.<ext>, relative to world.json */
export function unitPath(key: UnitKey, hash: string, ext: 'idx' | 'pack' | 'col'): string {
	return `u/${key.level}/${key.e}/${key.n}.${hash}.${ext}`;
}

const UNIT_PATH = /(?:^|\/)u\/(\d+)\/(-?\d+)\/(-?\d+)\.([0-9a-f]{16})\.(?:idx|pack|col)$/;

/** the unit key and hash of a unitPath */
export function parseUnitPath(path: string): (UnitKey & { hash: string }) | null {
	const m = UNIT_PATH.exec(path);
	if (!m) return null;
	return { level: Number(m[1]), e: Number(m[2]), n: Number(m[3]), hash: m[4] };
}

/** the units an idx names: its children, then its descendants two and three levels down */
export function namedUnits(idx: Idx): { key: UnitKey; hash: string }[] {
	const { level, e, n } = idx;
	const half = LEAF * 2 ** (level - 1);
	const named = idx.children.map(({ quadrant, idx: hash }) => ({
		key: { level: level - 1, e: e + (quadrant & 1) * half, n: n + (quadrant >> 1) * half },
		hash
	}));
	for (const { depth, column, row, idx: hash } of idx.descendants) {
		const side = LEAF * 2 ** (level - depth);
		named.push({ key: { level: level - depth, e: e + column * side, n: n + row * side }, hash });
	}
	return named;
}
