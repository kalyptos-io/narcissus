import { describe, expect, it } from 'vitest';
import { byteRange } from './range.ts';

describe('byteRange', () => {
	it('parses a single closed range', () => {
		expect(byteRange('bytes=0-0')).toEqual([0, 0]);
		expect(byteRange('bytes=100-107')).toEqual([100, 107]);
	});

	it('refuses every other form', () => {
		for (const header of [
			null,
			'',
			'bytes=10-',
			'bytes=-10',
			'bytes=0-1,5-6',
			'bytes=9-3',
			'items=0-1'
		])
			expect(byteRange(header)).toBeNull();
	});
});
