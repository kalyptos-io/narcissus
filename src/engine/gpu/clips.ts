// clips: half-spaces of the world every drawn splat is kept within, their planes in the extension
// as clip.wgsl reads them, in the floating-origin frame

import type { Plane } from '../types.ts';
import type { Block, Extension } from './extension.ts';

export class Clips {
	#extension: Extension;
	/** each clip's planes, unit normal then offset, in world coordinates */
	#clips = new Map<number, Float64Array>();
	#next = 0;
	#origin: readonly [number, number, number] = [0, 0, 0];
	/** the extension block of the planes */
	#block: Block | null = null;
	#count = 0;

	constructor(extension: Extension) {
		this.#extension = extension;
	}

	/** extension word of the first plane */
	get at(): number {
		return this.#block?.at ?? 0;
	}

	/** planes of every clip */
	get count(): number {
		return this.#count;
	}

	/** a new clip's id; a plane of no normal or not finite throws a RangeError */
	add(planes: readonly Plane[]): number {
		const unit = new Float64Array(planes.length * 4);
		planes.forEach((plane, k) => {
			const length = Math.hypot(plane[0], plane[1], plane[2]);
			if (plane.length !== 4 || !plane.every(Number.isFinite) || !(length > 0)) {
				throw new RangeError('A clip plane must be four finite numbers, its normal not 0.');
			}
			unit.set(
				plane.map((v) => v / length),
				k * 4
			);
		});
		this.#clips.set(++this.#next, unit);
		this.#write();
		return this.#next;
	}

	delete(id: number): void {
		if (this.#clips.delete(id)) this.#write();
	}

	setOrigin(origin: readonly [number, number, number]): void {
		this.#origin = origin;
		if (this.#count) this.#write();
	}

	#write(): void {
		const all = [...this.#clips.values()];
		this.#count = all.reduce((sum, planes) => sum + planes.length / 4, 0);
		this.#block = this.#extension.fit(this.#block, 4 * this.#count);
		const floats = new Float32Array(4 * this.#count);
		const [x, y, z] = this.#origin;
		let at = 0;
		for (const planes of all)
			for (let k = 0; k < planes.length; k += 4, at += 4) {
				const [a, b, c, d] = planes.subarray(k, k + 4);
				floats.set([a, b, c, d + a * x + b * y + c * z], at);
			}
		this.#extension.write(this.#block.at, new Uint32Array(floats.buffer));
	}
}
