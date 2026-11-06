// byte sources and byte caches; their adapters are in adapters/

/** bytes [start, end) of url, or the whole file for a null range; rejects with Missing for no file */
export type Fetch = (
	url: string,
	range: readonly [number, number] | null,
	signal?: AbortSignal
) => Promise<Uint8Array>;

/** a file is not there; an engine that meets one in an open world reads world.json again */
export class Missing extends Error {
	override name = 'Missing';
}

/** an error as it crosses postMessage, where its class is lost */
export type Failed = { error: string; missing: boolean };

/** what was thrown, as text */
export const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const failed = (error: unknown): Failed => ({
	error: reason(error),
	missing: error instanceof Missing
});

export const rethrown = ({ error, missing }: Failed) =>
	missing ? new Missing(error) : new Error(error);

/** raw network bytes by key; a miss is undefined, never an error */
export interface Cache {
	get(key: string): Promise<Uint8Array | undefined>;
	put(key: string, bytes: Uint8Array): Promise<void>;
}
