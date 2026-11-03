// host tables: u32 words in the extension, found by id through a directory there that sample.wgsl's
// table() reads, two words an id: the table's first word and its length

import type { Table } from '../plugin.ts';
import type { Block, Extension } from './extension.ts';

export class Tables {
	#extension: Extension;
	/** by id, its first word and length; 0 and 0 for a free id */
	#entries: number[] = [];
	#free: number[] = [];
	#directory: Block | null = null;

	constructor(extension: Extension) {
		this.#extension = extension;
	}

	/** the directory's first extension word */
	get directory(): number {
		return this.#directory?.at ?? 0;
	}

	/** ids the directory holds; table() reads 0 for any past them */
	get count(): number {
		return this.#entries.length / 2;
	}

	create(words: number): Table {
		if (!Number.isInteger(words) || words < 0) {
			throw new RangeError("A table's words must be a whole number, at least 0.");
		}
		const extension = this.#extension;
		const first = words ? extension.alloc(words) : 0;
		const id = this.#free.pop() ?? this.count;
		this.#set(id, first, words);
		let live = true;
		return {
			id,
			write: (at, values) => {
				if (!live) throw new Error('The table was destroyed.');
				if (!Number.isInteger(at) || at < 0 || at + values.length > words) {
					throw new RangeError(
						`A write of ${values.length} words at ${at} is past the table's ${words}.`
					);
				}
				extension.write(first + at, values);
			},
			destroy: () => {
				if (!live) return;
				live = false;
				if (words) extension.free(first);
				this.#set(id, 0, 0);
				this.#free.push(id);
			}
		};
	}

	#set(id: number, first: number, words: number): void {
		this.#entries[2 * id] = first;
		this.#entries[2 * id + 1] = words;
		const extension = this.#extension;
		const directory = extension.fit(this.#directory, 2 * this.count);
		if (directory === this.#directory) {
			extension.write(directory.at + 2 * id, new Uint32Array([first, words]));
			return;
		}
		this.#directory = directory;
		extension.write(directory.at, Uint32Array.from(this.#entries));
	}
}
