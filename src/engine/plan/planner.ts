// the main thread's side of the plan worker

import type { PageNodes } from '../../format/index.ts';
import type { UnitNode } from '../world/tree.ts';
import { unitInfo, unitKey, type CutRequest, type CutResult } from './cut.ts';
import type { PlanMessage, PlanReply } from './worker.ts';
// inline, so the built engine is one file that needs no path to its worker
import PlanWorker from './worker.ts?worker&inline';

export class Planner {
	#worker = new PlanWorker();
	#seq = 0;
	#waiting: { seq: number; resolve: (result: CutResult | null) => void } | null = null;

	constructor() {
		this.#worker.onmessage = ({ data }: MessageEvent<PlanReply>) => {
			const waiting = this.#waiting;
			if (data.seq !== waiting?.seq) return;
			this.#waiting = null;
			waiting.resolve(data.result);
		};
	}

	unit(unit: UnitNode, root: boolean): void {
		this.#post({ type: 'unit', unit: unitInfo(unit, root) });
	}

	drop(units: UnitNode[]): void {
		if (units.length) this.#post({ type: 'drop', keys: units.map(unitKey) });
	}

	/** a page the pool uploaded; its nodes move to the worker */
	page(id: number, nodes: PageNodes): void {
		const buffers = [nodes.counts, nodes.centres, nodes.radii, nodes.links].map((a) => a.buffer);
		this.#worker.postMessage({ type: 'page', id, nodes } satisfies PlanMessage, buffers);
	}

	evict(ids: number[]): void {
		if (ids.length) this.#post({ type: 'evict', ids });
	}

	/** forgets every unit and page; a plan in flight resolves null */
	reset(): void {
		this.#settle();
		this.#post({ type: 'reset' });
	}

	/** one at a time; applied says whether the pool took the last plan's masks */
	plan(request: CutRequest, applied: boolean): Promise<CutResult | null> {
		this.#settle();
		const seq = ++this.#seq;
		const { promise, resolve } = Promise.withResolvers<CutResult | null>();
		this.#waiting = { seq, resolve };
		this.#post({ type: 'plan', seq, request, applied });
		return promise;
	}

	destroy(): void {
		this.#settle();
		this.#worker.terminate();
	}

	#settle(): void {
		this.#waiting?.resolve(null);
		this.#waiting = null;
	}

	#post(message: PlanMessage): void {
		this.#worker.postMessage(message);
	}
}
