import { describe, expect, it } from 'vitest';
import { deflate, inflate, unwrap } from './inflate.ts';

async function prefixed(magic: string, version: number, body: Uint8Array): Promise<Uint8Array> {
	const z = await deflate(body);
	const out = new Uint8Array(8 + z.length);
	out.set(new TextEncoder().encode(magic));
	new DataView(out.buffer).setUint16(4, version, true);
	out.set(z, 8);
	return out;
}

describe('inflate', () => {
	it('restores what deflate packed', async () => {
		const bytes = Uint8Array.from({ length: 5000 }, (_, i) => (i * 7) % 13);
		const packed = await deflate(bytes);
		expect(packed.length).toBeLessThan(bytes.length);
		expect(await inflate(packed)).toEqual(bytes);
	});

	it('reads a view into a larger buffer', async () => {
		const packed = await deflate(new TextEncoder().encode('kikkert'));
		const padded = new Uint8Array(packed.length + 6);
		padded.set(packed, 3);
		const bytes = await inflate(padded.subarray(3, 3 + packed.length));
		expect(new TextDecoder().decode(bytes)).toBe('kikkert');
	});
});

describe('unwrap', () => {
	it('returns the inflated body of a prefixed file', async () => {
		const body = await unwrap(await prefixed('GMIX', 1, Uint8Array.of(1, 2, 3)), 'GMIX', '.idx');
		expect(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)).toEqual(
			Uint8Array.of(1, 2, 3)
		);
	});

	it('names a wrong magic, another version and a broken stream', async () => {
		const body = Uint8Array.of(1, 2, 3);
		await expect(unwrap(await prefixed('GMCL', 1, body), 'GMIX', '.idx')).rejects.toThrow(
			'not a .idx file'
		);
		await expect(unwrap(Uint8Array.of(71, 77), 'GMIX', '.idx')).rejects.toThrow('not a .idx');
		await expect(unwrap(await prefixed('GMIX', 2, body), 'GMIX', '.idx')).rejects.toThrow(
			'.idx version 2'
		);
		const broken = Uint8Array.of(71, 77, 73, 88, 1, 0, 0, 0, 0xff, 0xff, 0xff);
		await expect(unwrap(broken, 'GMIX', '.idx')).rejects.toThrow('not a valid deflate stream');
	});
});
