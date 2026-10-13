// a single closed range, bytes=a-b; callers answer every other form with the whole file

export function byteRange(header: string | null): [number, number] | null {
	const match = /^bytes=(\d+)-(\d+)$/.exec(header ?? '');
	if (!match) return null;
	const start = Number(match[1]);
	const end = Number(match[2]);
	return start <= end ? [start, end] : null;
}
