// byte sources and byte caches; their adapters are in adapters/

/** bytes [start, end) of url, or the whole file for a null range */
export type Fetch = (
	url: string,
	range: readonly [number, number] | null,
	signal?: AbortSignal
) => Promise<Uint8Array>;

/** raw network bytes by key; a miss is undefined, never an error */
export interface Cache {
	get(key: string): Promise<Uint8Array | undefined>;
	put(key: string, bytes: Uint8Array): Promise<void>;
}
