// lsd radix sort, 8 bits a pass: block digit counts, a two-level scan, a stable scatter; no spin-waits

const THREADS: u32 = 128u;
const ITEMS: u32 = 8u;
const BLOCK: u32 = 1024u;
// blocks per scan chunk
const CHUNK: u32 = 64u;
const DIGITS: u32 = 256u;

struct SortParams {
	shift: u32,
	// word offsets of the keys read and written; their values follow capacity words later
	src: u32,
	dst: u32,
	capacity: u32,
	// word offsets in the work buffer
	projected: u32,
	drawArgs: u32,
}

struct SortState {
	count: u32,
	blocks: u32,
	chunks: u32,
}

@group(0) @binding(0) var<uniform> params: SortParams;
@group(0) @binding(1) var<storage, read_write> data: array<u32>;
// block-major: count, then exclusive global offset, of digit d in block b at b DIGITS + d
@group(0) @binding(2) var<storage, read_write> hist: array<u32>;
// chunk-major sums of hist, then their exclusive global offsets
@group(0) @binding(3) var<storage, read_write> sums: array<u32>;
@group(0) @binding(4) var<storage, read> state: SortState;
@group(0) @binding(5) var<storage, read_write> stateOut: SortState;
@group(0) @binding(6) var<storage, read_write> work: array<u32>;

var<workgroup> bins: array<atomic<u32>, DIGITS>;
var<workgroup> totals: array<u32, DIGITS>;
var<workgroup> sk: array<u32, BLOCK>;
var<workgroup> sv: array<u32, BLOCK>;
// three 10-bit counts; the fourth follows from the number of items
var<workgroup> counts: array<u32, THREADS * 2u>;
var<workgroup> tail: u32;
var<workgroup> starts: array<u32, DIGITS>;
var<workgroup> offsets: array<u32, DIGITS>;

fn unpack(packed: u32, count: u32) -> vec4u {
	let a = packed & 1023u;
	let b = (packed >> 10u) & 1023u;
	let c = (packed >> 20u) & 1023u;
	return vec4u(a, b, c, count - a - b - c);
}

fn digit(key: u32) -> u32 {
	return (key >> params.shift) & 0xffu;
}

@compute @workgroup_size(1)
fn prepare() {
	let count = min(work[params.projected], params.capacity);
	let blocks = (count + BLOCK - 1u) / BLOCK;
	work[params.drawArgs] = 4u;
	work[params.drawArgs + 1u] = count;
	work[params.drawArgs + 2u] = 0u;
	work[params.drawArgs + 3u] = 0u;
	stateOut = SortState(count, blocks, (blocks + CHUNK - 1u) / CHUNK);
}

@compute @workgroup_size(THREADS)
fn histogram(
	@builtin(workgroup_id) wid: vec3u,
	@builtin(num_workgroups) groups: vec3u,
	@builtin(local_invocation_index) t: u32
) {
	let block = wid.y * groups.x + wid.x;
	if (block >= state.blocks) {
		return;
	}
	for (var d = t; d < DIGITS; d += THREADS) {
		atomicStore(&bins[d], 0u);
	}
	workgroupBarrier();
	let head = block * BLOCK;
	for (var k = 0u; k < ITEMS; k++) {
		let i = head + k * THREADS + t;
		if (i < state.count) {
			atomicAdd(&bins[digit(data[params.src + i])], 1u);
		}
	}
	workgroupBarrier();
	for (var d = t; d < DIGITS; d += THREADS) {
		hist[block * DIGITS + d] = atomicLoad(&bins[d]);
	}
}

@compute @workgroup_size(DIGITS)
fn reduce(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) t: u32) {
	let end = min((wid.x + 1u) * CHUNK, state.blocks);
	var sum = 0u;
	for (var b = wid.x * CHUNK; b < end; b++) {
		sum += hist[b * DIGITS + t];
	}
	sums[wid.x * DIGITS + t] = sum;
}

@compute @workgroup_size(DIGITS)
fn top(@builtin(local_invocation_index) t: u32) {
	var run = 0u;
	for (var c = 0u; c < state.chunks; c++) {
		let x = sums[c * DIGITS + t];
		sums[c * DIGITS + t] = run;
		run += x;
	}
	totals[t] = run;
	workgroupBarrier();
	for (var o = 1u; o < DIGITS; o *= 2u) {
		var x = 0u;
		if (t >= o) {
			x = totals[t - o];
		}
		workgroupBarrier();
		totals[t] += x;
		workgroupBarrier();
	}
	let base = totals[t] - run;
	for (var c = 0u; c < state.chunks; c++) {
		sums[c * DIGITS + t] += base;
	}
}

@compute @workgroup_size(DIGITS)
fn down(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_index) t: u32) {
	let end = min((wid.x + 1u) * CHUNK, state.blocks);
	var run = sums[wid.x * DIGITS + t];
	for (var b = wid.x * CHUNK; b < end; b++) {
		let x = hist[b * DIGITS + t];
		hist[b * DIGITS + t] = run;
		run += x;
	}
}

@compute @workgroup_size(THREADS)
fn scatter(
	@builtin(workgroup_id) wid: vec3u,
	@builtin(num_workgroups) groups: vec3u,
	@builtin(local_invocation_index) t: u32
) {
	let block = wid.y * groups.x + wid.x;
	if (block >= state.blocks) {
		return;
	}
	let head = block * BLOCK;
	let valid = min(BLOCK, state.count - head);
	// padding has digit 255 at every shift, so it sorts behind the valid keys and is never written
	for (var k = 0u; k < ITEMS; k++) {
		let i = k * THREADS + t;
		var key = 0xffffffffu;
		var value = 0u;
		if (i < valid) {
			key = data[params.src + head + i];
			value = data[params.src + params.capacity + head + i];
		}
		sk[i] = key;
		sv[i] = value;
	}
	for (var d = t; d < DIGITS; d += THREADS) {
		offsets[d] = hist[block * DIGITS + d];
	}
	workgroupBarrier();

	// stable local sort by the digit, two bits a split; thread t owns positions t ITEMS + k
	for (var bit = 0u; bit < 8u; bit += 2u) {
		var keys: array<u32, ITEMS>;
		var values: array<u32, ITEMS>;
		var before: array<u32, ITEMS>;
		var mine = vec4u(0u);
		for (var k = 0u; k < ITEMS; k++) {
			keys[k] = sk[t * ITEMS + k];
			values[k] = sv[t * ITEMS + k];
			let b = (keys[k] >> (params.shift + bit)) & 3u;
			before[k] = mine[b];
			mine[b] += 1u;
		}
		counts[t] = mine.x | (mine.y << 10u) | (mine.z << 20u);
		if (t == THREADS - 1u) {
			tail = counts[t];
		}
		workgroupBarrier();
		// separate reads and writes need only one barrier per scan step
		var source = 0u;
		for (var o = 1u; o < THREADS; o *= 2u) {
			var x = counts[source + t];
			if (t >= o) {
				x += counts[source + t - o];
			}
			let dest = source ^ THREADS;
			counts[dest + t] = x;
			workgroupBarrier();
			source = dest;
		}
		// prefixes stop at 1016 items, so no count carries into its neighbour
		let total = unpack(counts[source + THREADS - 2u], BLOCK - ITEMS) + unpack(tail, ITEMS);
		var prior = vec4u(0u);
		if (t > 0u) {
			prior = unpack(counts[source + t - 1u], t * ITEMS);
		}
		let base = vec4u(0u, total.x, total.x + total.y, total.x + total.y + total.z);
		for (var k = 0u; k < ITEMS; k++) {
			let b = (keys[k] >> (params.shift + bit)) & 3u;
			let p = base[b] + prior[b] + before[k];
			sk[p] = keys[k];
			sv[p] = values[k];
		}
		workgroupBarrier();
	}

	for (var k = 0u; k < ITEMS; k++) {
		let i = t * ITEMS + k;
		let d = digit(sk[i]);
		if (i == 0u || digit(sk[i - 1u]) != d) {
			starts[d] = i;
		}
	}
	workgroupBarrier();
	for (var k = 0u; k < ITEMS; k++) {
		let i = k * THREADS + t;
		if (i < valid) {
			let d = digit(sk[i]);
			let slot = offsets[d] + i - starts[d];
			data[params.dst + slot] = sk[i];
			data[params.dst + params.capacity + slot] = sv[i];
		}
	}
}
