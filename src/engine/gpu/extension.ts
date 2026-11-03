// stand-in for the extension buffer until attribute streams land: a static region of u32 words
// allocated by bumping, then a frame region the passes write

export class Extension {
	#buffer: GPUBuffer;
	#device: GPUDevice;
	#mirror: Uint32Array<ArrayBuffer>;
	#top = 0;
	#frame = 0;
	#dirty = false;

	constructor(device: GPUDevice, words: number) {
		this.#device = device;
		this.#mirror = new Uint32Array(Math.max(4, words));
		this.#buffer = this.#make(this.#mirror.length);
	}

	get buffer(): GPUBuffer {
		return this.#buffer;
	}

	alloc(words: number): number {
		const at = this.#top;
		this.#top += words;
		if (this.#top > this.#mirror.length) {
			const grown = new Uint32Array(2 ** Math.ceil(Math.log2(this.#top)));
			grown.set(this.#mirror);
			this.#mirror = grown;
		}
		return at;
	}

	free(at: number): void {
		void at;
	}

	write(at: number, words: Uint32Array): void {
		this.#mirror.set(words, at);
		this.#dirty = true;
	}

	/** the word offset of a frame region of words, after the static region */
	frame(words: number): number {
		this.#frame = words;
		return this.#top;
	}

	flush(): boolean {
		const need = Math.max(this.#mirror.length, this.#top + this.#frame);
		const replaced = need * 4 > this.#buffer.size;
		if (replaced) {
			this.#buffer.destroy();
			this.#buffer = this.#make(2 ** Math.ceil(Math.log2(need)));
		}
		if (this.#dirty || replaced) this.#device.queue.writeBuffer(this.#buffer, 0, this.#mirror);
		this.#dirty = false;
		return replaced;
	}

	destroy(): void {
		this.#buffer.destroy();
	}

	#make(words: number): GPUBuffer {
		const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
		return this.#device.createBuffer({ label: 'extension', size: words * 4, usage });
	}
}
