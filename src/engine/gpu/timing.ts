/** gpu ms per named pass from timestamp queries; inert without them */
export class Timing {
	/** ms per pass of the last frame read */
	readonly ms: Record<string, number> = {};
	#passes: readonly string[];
	#queries: GPUQuerySet | undefined;
	#resolved: GPUBuffer | undefined;
	#readback: GPUBuffer | undefined;
	#mapping = false;
	#fresh = false;

	constructor(device: GPUDevice, enabled: boolean, passes: readonly string[]) {
		this.#passes = passes;
		if (!enabled) return;
		const count = passes.length * 2;
		this.#queries = device.createQuerySet({ label: 'timing', type: 'timestamp', count });
		this.#resolved = device.createBuffer({
			label: 'timing resolved',
			size: count * 8,
			usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
		});
		this.#readback = device.createBuffer({
			label: 'timing readback',
			size: count * 8,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
	}

	/** timestamp writes of a compute or render pass */
	writes(pass: string) {
		const queries = this.#queries;
		if (!queries) return undefined;
		const k = this.#passes.indexOf(pass);
		return { querySet: queries, beginningOfPassWriteIndex: 2 * k, endOfPassWriteIndex: 2 * k + 1 };
	}

	/** resolves this frame's queries; call last in the frame's encoder */
	resolve(encoder: GPUCommandEncoder): void {
		if (!this.#queries || !this.#resolved || !this.#readback || this.#mapping) return;
		encoder.resolveQuerySet(this.#queries, 0, this.#passes.length * 2, this.#resolved, 0);
		encoder.copyBufferToBuffer(this.#resolved, 0, this.#readback, 0, this.#readback.size);
		this.#fresh = true;
	}

	/** maps the resolved queries once the frame is submitted; the latest read wins */
	read(): void {
		const readback = this.#readback;
		if (!readback || this.#mapping || !this.#fresh) return;
		this.#mapping = true;
		this.#fresh = false;
		// the map rejects once destroyed or the device is lost
		readback
			.mapAsync(GPUMapMode.READ)
			.then(() => {
				const ns = new BigUint64Array(readback.getMappedRange());
				this.#passes.forEach((pass, k) => {
					const [begin, end] = [ns[2 * k], ns[2 * k + 1]];
					// passes not run this frame resolve to zero
					this.ms[pass] = end > begin ? Number(end - begin) / 1e6 : 0;
				});
				readback.unmap();
			})
			.catch(() => {})
			.finally(() => (this.#mapping = false));
	}

	destroy(): void {
		this.#queries?.destroy();
		this.#resolved?.destroy();
		this.#readback?.destroy();
	}
}
