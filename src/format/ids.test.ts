import { describe, expect, it } from 'vitest';
import { parseIds } from './ids.ts';
import { encodeIds, wrap } from './encode.ts';
import { IDS_MAGIC } from './spec.ts';

describe('parseIds', () => {
	it('reads back what encodeIds wrote', async () => {
		const ids = Uint16Array.of(0, 1, 7, 65535, 7);
		expect(await parseIds(await encodeIds(ids))).toEqual(ids);
	});

	it('rejects a body cut short of its rows', async () => {
		const body = new Uint8Array(4 + 2 * 2);
		new DataView(body.buffer).setUint32(0, 3, true);
		await expect(parseIds(await wrap(body, IDS_MAGIC))).rejects.toThrow(
			'.ids holds 8 bytes, 3 rows need 10'
		);
	});
});
