import { describe, expect, it, vi } from 'vitest';
import type { Attribute } from '../../format/index.ts';
import type { Extension } from '../gpu/extension.ts';
import { AttributeRegistry, widen } from './attributes.ts';

const DECLARED: Record<string, Attribute> = {
	'test.class': { type: 'u16', components: 1, default: [7], rule: 'preserved' },
	'test.tone': { type: 'f16', components: 2, default: [0.5, -2], rule: 'aggregated' },
	'test.lean': { type: 'i8', components: 1, default: [-3], rule: 'preserved' },
	'test.parts': { type: 'records', components: 0, default: [], rule: 'preserved' }
};

function registry() {
	const writes: { at: number; words: number[] }[] = [];
	const extension = {
		write: (at: number, words: Uint32Array) => writes.push({ at, words: Array.from(words) })
	} as unknown as Extension;
	const changed = vi.fn();
	const attributes = new AttributeRegistry(extension, changed);
	attributes.open(DECLARED);
	return { attributes, writes, changed };
}

describe('AttributeRegistry', () => {
	it('gives a stream one id while the registry lives, and writes its default widened', () => {
		const { attributes, writes } = registry();
		const tone = attributes.use('test.tone', true);
		const lean = attributes.use('test.lean', false);
		expect([tone, lean]).toEqual([0, 1]);
		expect(attributes.use('test.tone', false)).toBe(tone);
		attributes.release(tone);
		attributes.release(tone);
		expect(attributes.use('test.tone', false)).toBe(tone);
		expect(writes).toEqual([
			{ at: 0, words: [widen('f16', 0.5), widen('f16', -2), 0, 0] },
			{ at: 4, words: [0xfffffffd, 0, 0, 0] }
		]);
		expect(attributes.declared('test.tone')).toEqual({ type: 'f16', components: 2 });
		expect(attributes.declared('test.parts')).toEqual({ type: 'records', components: 0 });
	});

	it('wants a stream while a hook reads it, required once any hook required it', () => {
		const { attributes, changed } = registry();
		const id = attributes.use('test.class', false);
		attributes.use('test.class', true);
		expect(attributes.wanted).toEqual([
			{ id, name: 'test.class', required: true, attribute: DECLARED['test.class'] }
		]);
		expect([attributes.generation, changed.mock.calls.length]).toEqual([1, 1]);
		attributes.release(id);
		attributes.release(id);
		expect(attributes.wanted).toEqual([]);
		attributes.use('test.class', false);
		expect(attributes.wanted[0].required).toBe(false);
		expect([attributes.generation, changed.mock.calls.length]).toEqual([2, 2]);
	});

	it('gives -1 for a stream the open world does not declare', () => {
		const { attributes, changed } = registry();
		expect(attributes.use('other.thing', true)).toBe(-1);
		expect(attributes.declared('other.thing')).toBeUndefined();
		expect(attributes.wanted).toEqual([]);
		expect(changed).not.toHaveBeenCalled();
	});

	it('resolves every id again when another world opens', () => {
		const { attributes, writes } = registry();
		const id = attributes.use('test.class', false);
		attributes.use('test.parts', false);
		writes.length = 0;
		attributes.open({ 'test.class': { ...DECLARED['test.class'], default: [9] } });
		expect(writes).toEqual([
			{ at: 0, words: [9, 0, 0, 0] },
			{ at: 4, words: [0, 0, 0, 0] }
		]);
		// the parts stream is undeclared now, so no worker fetches it
		expect(attributes.wanted.map((w) => w.id)).toEqual([id]);
		expect(attributes.use('test.parts', false)).toBe(-1);
	});

	it('takes at most 64 streams', () => {
		const { attributes } = registry();
		const many = Object.fromEntries(
			Array.from({ length: 65 }, (_, k) => [`many.s${k}`, DECLARED['test.class']])
		);
		attributes.open(many);
		for (let k = 0; k < 64; k++) attributes.use(`many.s${k}`, false);
		expect(() => attributes.use('many.s64', false)).toThrow('64 attribute streams at most');
	});
});
