// the attribute streams installed hooks read: an engine id each, its default in the extension, and
// what the stream workers fetch with each page

import type { Attribute } from '../../format/index.ts';
import type { Extension } from '../gpu/extension.ts';
import { ATTRIBUTE_STREAMS } from '../gpu/layout.ts';

/** a stream some hook reads, as a stream worker gets it */
export interface Wanted {
	id: number;
	name: string;
	/** a page whose unit holds a chunk of it waits for that chunk, and fails without it */
	required: boolean;
	/** the open world's declaration */
	attribute: Attribute;
}

/** the bits attributes.wgsl gives a value of a fixed stream of type */
export function widen(type: Attribute['type'], value: number): number {
	if (type === 'f16' || type === 'f32') return new Uint32Array(Float32Array.of(value).buffer)[0];
	return value >>> 0;
}

export class AttributeRegistry {
	#extension: Extension;
	#onChange: () => void;
	#declared: Readonly<Record<string, Attribute>> = {};
	/** ids by name, kept while the registry lives so a stream used again keeps its id */
	#ids = new Map<string, number>();
	#names: string[] = [];
	/** the hooks reading each id, and whether any of them required it */
	#uses = new Map<number, { count: number; required: boolean }>();
	#generation = 0;

	/** onChange runs when the wanted streams grow, so resident pages fetch what they lack */
	constructor(extension: Extension, onChange: () => void) {
		this.#extension = extension;
		this.#onChange = onChange;
	}

	/**
	 * the streams world.json declares; every id is resolved against them again: its default
	 * rewritten, and a stream this world does not declare no longer fetched
	 */
	open(declared: Readonly<Record<string, Attribute>>): void {
		this.#declared = declared;
		this.#names.forEach((_, id) => this.#writeDefault(id));
	}

	/** the open world's scalar type and components of stream name; undefined when it does not declare it */
	declared(name: string): Pick<Attribute, 'type' | 'components'> | undefined {
		const a = this.#declared[name];
		return a && { type: a.type, components: a.components };
	}

	/** the engine id of stream name for a hook that reads it; -1 when the open world does not declare it */
	use(name: string, required: boolean): number {
		if (!this.#declared[name]) return -1;
		let id = this.#ids.get(name);
		if (id === undefined) {
			if (this.#names.length >= ATTRIBUTE_STREAMS) {
				throw new Error(`An engine reads ${ATTRIBUTE_STREAMS} attribute streams at most.`);
			}
			id = this.#names.push(name) - 1;
			this.#ids.set(name, id);
			this.#writeDefault(id);
		}
		const use = this.#uses.get(id);
		// once required, a stream stays so until every hook released it: release does not say which
		if (use) {
			use.count++;
			use.required ||= required;
		} else {
			this.#uses.set(id, { count: 1, required });
			this.#generation++;
			this.#onChange();
		}
		return id;
	}

	release(id: number): void {
		const use = this.#uses.get(id);
		if (use && --use.count === 0) this.#uses.delete(id);
	}

	/** the streams some hook reads that the open world declares */
	get wanted(): Wanted[] {
		const wanted: Wanted[] = [];
		for (const [id, { required }] of this.#uses) {
			const attribute = this.#attribute(id);
			if (attribute) wanted.push({ id, name: this.#names[id], required, attribute });
		}
		return wanted;
	}

	/** grows each time a stream comes to be read; a page loaded before it may lack its chunk */
	get generation(): number {
		return this.#generation;
	}

	#attribute(id: number): Attribute | undefined {
		return this.#declared[this.#names[id]];
	}

	#writeDefault(id: number): void {
		const a = this.#attribute(id);
		const words = new Uint32Array(4);
		if (a) a.default.forEach((value, c) => (words[c] = widen(a.type, value)));
		this.#extension.write(4 * id, words);
	}
}
