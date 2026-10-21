// the plan worker: the cut off the main thread, its messages taken in the order they were sent

import type { PageNodes } from '../../format/index.ts';
import { Cut, type CutRequest, type CutResult, type UnitInfo } from './cut.ts';

export type PlanMessage =
	| { type: 'unit'; unit: UnitInfo }
	| { type: 'drop'; keys: string[] }
	| { type: 'page'; id: number; nodes: PageNodes }
	| { type: 'evict'; ids: number[] }
	| { type: 'reset' }
	/** applied: whether the pool took the last plan's masks */
	| { type: 'plan'; seq: number; request: CutRequest; applied: boolean };

export interface PlanReply {
	seq: number;
	result: CutResult;
}

// the dom lib has no worker scope types
const scope = self as unknown as {
	onmessage: (event: MessageEvent<PlanMessage>) => void;
	postMessage(message: PlanReply, transfer: Transferable[]): void;
};

let cut = new Cut();

scope.onmessage = ({ data }) => {
	switch (data.type) {
		case 'unit':
			cut.unit(data.unit);
			break;
		case 'drop':
			for (const key of data.keys) cut.drop(key);
			break;
		case 'page':
			cut.page(data.id, data.nodes);
			break;
		case 'evict':
			for (const id of data.ids) cut.evict(id);
			break;
		case 'reset':
			cut = new Cut();
			break;
		case 'plan': {
			cut.verdict(data.applied);
			// copied, not moved: the cut keeps the masks to tell the next plan's changes
			scope.postMessage({ seq: data.seq, result: cut.plan(data.request) }, []);
		}
	}
};
