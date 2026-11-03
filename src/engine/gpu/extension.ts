// one storage buffer of u32 words for what extends the passes: attribute streams, plugin tables
// and each frame's sample records; first-fit blocks that grow the buffer at flush

interface Block {
	at: number;
	words: number;
}

export class Extension {
	#buffer: GPUBuffer;
	#device: GPUDevice;
	/** words the buffer holds */
	#size: number;
	/** words below which every block lies */
	#top = 0;
	/** free blocks below top, by offset, none adjacent */
	#free: Block[] = [];
	/** blocks in use by offset */
	#taken = new Map<number, number>();
	#writes: { at: number; words: Uint32Array }[] = [];
	#frame: Block | null = null;

	constructor(device: GPUDevice, words: number) {
		this.#device = device;
		this.#size = Math.max(1, words);
		this.#buffer = this.#make(this.#size);
	}

	/** replaced on grow */
	get buffer(): GPUBuffer {
		return this.#buffer;
	}

	/** bytes of the buffer */
	get bytes(): number {
		return this.#buffer.size;
	}

	/** word offset of a block of words, at least one, in the static region */
	alloc(words: number): number {
		words = Math.max(1, Math.ceil(words));
		const k = this.#free.findIndex((block) => block.words >= words);
		let at: number;
		if (k < 0) {
			at = this.#top;
			this.#top += words;
		} else {
			const block = this.#free[k];
			at = block.at;
			if (block.words === words) this.#free.splice(k, 1);
			else this.#free[k] = { at: at + words, words: block.words - words };
		}
		this.#taken.set(at, words);
		return at;
	}

	free(at: number): void {
		const words = this.#taken.get(at);
		if (words === undefined) return;
		this.#taken.delete(at);
		let block: Block = { at, words };
		let k = this.#free.findIndex((b) => b.at > at);
		if (k < 0) k = this.#free.length;
		const before = this.#free[k - 1];
		if (before && before.at + before.words === at) {
			block = { at: before.at, words: before.words + words };
			this.#free.splice(--k, 1);
		}
		const after = this.#free[k];
		if (after && block.at + block.words === after.at) {
			block = { at: block.at, words: block.words + after.words };
			this.#free.splice(k, 1);
		}
		if (block.at + block.words === this.#top) this.#top = block.at;
		else this.#free.splice(k, 0, block);
	}

	/** copies words in at word offset at when flushed; the caller leaves them unchanged till then */
	write(at: number, words: Uint32Array): void {
		if (words.length) this.#writes.push({ at, words });
	}

	/** this frame's region of words; its offset holds while the frame asks for no more */
	frame(words: number): number {
		if (!this.#frame || this.#frame.words < words) {
			if (this.#frame) this.free(this.#frame.at);
			const size = Math.max(words, 2 * (this.#frame?.words ?? 0));
			this.#frame = { at: this.alloc(size), words: size };
		}
		return this.#frame.at;
	}

	/** grows the buffer to hold every block, then uploads the writes; true when it replaced the buffer */
	flush(): boolean {
		let grown = false;
		if (this.#top > this.#size) {
			const limit = this.#device.limits.maxStorageBufferBindingSize / 4;
			if (this.#top > limit) throw new Error(`the extension buffer needs ${4 * this.#top} bytes`);
			const size = Math.min(limit, Math.max(this.#top, 2 * this.#size));
			const buffer = this.#make(size);
			const encoder = this.#device.createCommandEncoder({ label: 'extension grow' });
			encoder.copyBufferToBuffer(this.#buffer, 0, buffer, 0, this.#buffer.size);
			this.#device.queue.submit([encoder.finish()]);
			this.#buffer.destroy();
			this.#buffer = buffer;
			this.#size = size;
			grown = true;
		}
		const queue = this.#device.queue;
		for (const { at, words } of this.#writes) queue.writeBuffer(this.#buffer, at * 4, words);
		this.#writes = [];
		return grown;
	}

	destroy(): void {
		this.#buffer.destroy();
	}

	#make(words: number): GPUBuffer {
		// copy-src lets it grow, and tests read it back
		const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
		return this.#device.createBuffer({ label: 'extension', size: words * 4, usage });
	}
}
