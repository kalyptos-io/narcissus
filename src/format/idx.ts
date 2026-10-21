import type { Idx, PageRow, UnitKey } from './types.ts';
import { unwrap } from './inflate.ts';
import {
	CHILD_BYTES,
	DESCENDANT_BYTES,
	IDX_HEADER,
	IDX_MAGIC,
	LEAF,
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

/** a 40-byte page row at offset, as in .idx and the .pack table */
export function rowAt(view: DataView, offset: number): PageRow {
	const box = new Float32Array(6);
	for (let k = 0; k < 6; k++) box[k] = view.getFloat32(offset + 8 + 4 * k, true);
	return {
		g: view.getUint8(offset),
		i: view.getUint8(offset + 1),
		j: view.getUint8(offset + 2),
		flags: view.getUint8(offset + 3),
		count: view.getUint32(offset + 4, true),
		box,
		offset: view.getUint32(offset + 32, true),
		length: view.getUint32(offset + 36, true)
	};
}

/** throws an Error naming the fault when the bytes are not a v2 .idx */
export async function parseIdx(bytes: Uint8Array): Promise<Idx> {
	const v = await unwrap(bytes, IDX_MAGIC, '.idx', VERSION);
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

/** a unit's name in maps and sets: L/E/N */
export function unitKey({ level, e, n }: UnitKey): string {
	return `${level}/${e}/${n}`;
}

/** the child of key at quadrant a + 2b, a east and b north */
export function childKey({ level, e, n }: UnitKey, quadrant: number): UnitKey {
	const half = LEAF * 2 ** (level - 1);
	return { level: level - 1, e: e + (quadrant & 1) * half, n: n + (quadrant >> 1) * half };
}

/** the quadrant a + 2b of key whose square holds below, a unit any levels down */
export function quadrantOf(key: UnitKey, below: UnitKey): number {
	const half = LEAF * 2 ** (key.level - 1);
	return Math.floor((below.e - key.e) / half) + 2 * Math.floor((below.n - key.n) / half);
}

/** the morton code of (x, y), x in the even bits; a byte each, as a row holds its i and j */
export function morton(x: number, y: number): number {
	let m = 0;
	for (let b = 0; b < 8; b++) m |= (((x >> b) & 1) << (2 * b)) | (((y >> b) & 1) << (2 * b + 1));
	return m;
}

/** the even bits of m packed together: x of morton code m, and y of m >> 1 */
export function evenBits(m: number): number {
	let v = 0;
	for (let b = 0; b < 8; b++) v |= ((m >> (2 * b)) & 1) << b;
	return v;
}

/** the units an idx names: its children, then its descendants two and three levels down */
export function namedUnits(idx: Idx): { key: UnitKey; hash: string }[] {
	const { level, e, n } = idx;
	const named = idx.children.map(({ quadrant, idx: hash }) => ({
		key: childKey(idx, quadrant),
		hash
	}));
	for (const { depth, column, row, idx: hash } of idx.descendants) {
		const side = LEAF * 2 ** (level - depth);
		named.push({ key: { level: level - depth, e: e + column * side, n: n + row * side }, hash });
	}
	return named;
}
