import { blake2b } from '@noble/hashes/blake2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** the 16 hex digits in a unit file's name: the blake2b digest of size 8 of its bytes */
export function contentHash(bytes: Uint8Array): string {
	return bytesToHex(blake2b(bytes, { dkLen: 8 }));
}
