import { describe, expect, it } from 'vitest';
import { bufferLayout } from './buffers.ts';
import common from './common.wgsl?raw';
import coverage from './coverage.wgsl?raw';
import { FRAME_UNIFORM_BYTES, LOW_PASS } from './layout.ts';
import masks from './masks.wgsl?raw';
import splat from './splat.wgsl?raw';
import * as ref from './test-coverage.ts';
import type { Posterior, Posterior2, Vec2, Vec3 } from './test-coverage.ts';
import { readBuffer, testDevice } from './test-device.ts';

/** the dropped tail's bound, 4 Φ(-3.73) */
const TAIL = 4 * ref.cdf(-ref.HALF_SIDE);
const TARGET = 1 / 255;

// u32 words in, f32 out; a body reads word k of its case as c(k) or w(k) and writes put(k, x)
const harness = (stride: number, out: number, body: string) => `
@group(0) @binding(0) var<uniform> uniforms: FrameUniforms;
@group(0) @binding(1) var<storage, read> cases: array<u32>;
@group(0) @binding(2) var<storage, read_write> results: array<f32>;
@group(0) @binding(3) var<storage, read_write> over: atomic<u32>;
@group(0) @binding(4) var<storage, read> geometry: array<vec4u>;
@group(0) @binding(5) var<storage, read> colours: array<u32>;
@group(0) @binding(6) var<storage, read> pages: array<Page>;

fn coverage_over() {
	atomicAdd(&over, 1u);
}

var<private> at: u32;
fn w(k: u32) -> u32 {
	return cases[at * ${stride}u + k];
}
fn c(k: u32) -> f32 {
	return bitcast<f32>(w(k));
}
fn put(k: u32, x: f32) {
	results[at * ${out}u + k] = x;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
	at = id.x;
	if (at >= arrayLength(&results) / ${out}u) {
		return;
	}
	${body}
}`;

interface Kernel {
	stride: number;
	out: number;
	body: string;
}

/** each case's out results and the over-budget count, from one dispatch */
async function run(
	kernel: Kernel,
	words: Uint32Array,
	{ uniforms = new Float32Array(FRAME_UNIFORM_BYTES / 4), constants = {} } = {}
): Promise<{ results: Float32Array; over: number }> {
	const device = await testDevice();
	const count = words.length / kernel.stride;
	const layout = bufferLayout(device, 'coverage test', GPUShaderStage.COMPUTE, [
		'uniform',
		'read-only-storage',
		'storage',
		'storage'
	]);
	device.pushErrorScope('validation');
	const module = device.createShaderModule({
		code: [common, masks, splat, coverage, harness(kernel.stride, kernel.out, kernel.body)].join(
			'\n'
		)
	});
	const pipeline = device.createComputePipeline({
		layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
		compute: { module, entryPoint: 'main', constants }
	});
	const error = await device.popErrorScope();
	if (error) throw new Error(error.message);
	const make = (size: number, usage: number) => device.createBuffer({ size, usage });
	const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
	const buffers = [
		make(uniforms.byteLength, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST),
		make(words.byteLength, storage),
		make(count * kernel.out * 4, storage),
		make(4, storage)
	];
	device.queue.writeBuffer(buffers[0], 0, uniforms);
	device.queue.writeBuffer(buffers[1], 0, words);
	const encoder = device.createCommandEncoder();
	const pass = encoder.beginComputePass();
	pass.setPipeline(pipeline);
	pass.setBindGroup(
		0,
		device.createBindGroup({
			layout,
			entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } }))
		})
	);
	pass.dispatchWorkgroups(Math.ceil(count / 64));
	pass.end();
	device.queue.submit([encoder.finish()]);
	const results = new Float32Array(await readBuffer(device, buffers[2]));
	const over = new Uint32Array(await readBuffer(device, buffers[3]))[0];
	buffers.forEach((b) => b.destroy());
	return { results, over };
}

/** f32 words of each case's numbers, in order */
function pack(cases: number[][]): Uint32Array {
	return new Uint32Array(new Float32Array(cases.flat()).buffer);
}

/** mulberry32 */
function random(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const POLYGON: Kernel = {
	stride: 30,
	out: 1,
	body: `let p = Posterior2(vec2f(c(0u), c(1u)), mat2x2f(c(2u), c(3u), c(3u), c(4u)));
	var v: array<vec2f, 12>;
	for (var k = 0u; k < 12u; k++) {
		v[k] = vec2f(c(6u + 2u * k), c(7u + 2u * k));
	}
	put(0u, polygon(p, v, w(5u)));`
};

/** a POLYGON case; count is a u32 word, so it is packed apart */
function polygonCase(p: Posterior2, v: Vec2[]): number[] {
	const flat = v.flat();
	return [
		p.mean[0],
		p.mean[1],
		p.cov[0][0],
		p.cov[0][1],
		p.cov[1][1],
		0,
		...flat,
		...Array(24 - flat.length).fill(0)
	];
}

async function polygons(cases: [Posterior2, Vec2[]][], constants = {}) {
	const words = pack(cases.map(([p, v]) => polygonCase(p, v)));
	cases.forEach(([, v], i) => (words[i * POLYGON.stride + 5] = v.length));
	return run(POLYGON, words, { constants });
}

/** the convex hull of points, counter-clockwise */
function hull(points: Vec2[]): Vec2[] {
	const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const cross = (o: Vec2, a: Vec2, b: Vec2) =>
		(a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
	const half = (list: Vec2[]) => {
		const out: Vec2[] = [];
		for (const q of list) {
			while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], q) <= 0) out.pop();
			out.push(q);
		}
		return out.slice(0, -1);
	};
	return [...half(sorted), ...half([...sorted].reverse())];
}

/** a posterior with sigmas over e^-3 to e^3 and any correlation short of 0.99 */
function posterior2(next: () => number): Posterior2 {
	const [sx, sy] = [Math.exp(6 * next() - 3), Math.exp(6 * next() - 3)];
	const rho = 1.98 * next() - 0.99;
	return {
		mean: [4 * next() - 2, 4 * next() - 2],
		cov: [
			[sx * sx, rho * sx * sy],
			[rho * sx * sy, sy * sy]
		]
	};
}

/** a convex polygon of up to 12 vertices near p, whitened size over e^-3 to e^2 */
function polygonNear(next: () => number, p: Posterior2): Vec2[] {
	const scale = Math.exp(5 * next() - 3);
	const [sx, sy] = [Math.sqrt(p.cov[0][0]), Math.sqrt(p.cov[1][1])];
	const centre = [3 * next() - 1.5, 3 * next() - 1.5].map((x) => x * (1 + scale));
	for (;;) {
		const points = Array.from({ length: 3 + Math.floor(10 * next()) }, () => {
			const [a, r] = [2 * Math.PI * next(), scale * Math.sqrt(next())];
			const [x, y] = [centre[0] + r * Math.cos(a), centre[1] + r * Math.sin(a)];
			return [p.mean[0] + x * sx, p.mean[1] + y * sy] as Vec2;
		});
		const v = hull(points);
		if (v.length >= 3 && v.length <= 12) return v;
	}
}

/** the convex pieces, counter-clockwise, of a plane cut by rays out of o at angles, far away */
function wedges(o: Vec2, angles: number[], far: number): Vec2[][] {
	const ray = (a: number): Vec2 => [o[0] + far * Math.cos(a), o[1] + far * Math.sin(a)];
	return angles.map((a, k) => {
		const b = angles[(k + 1) % angles.length] + (k + 1 === angles.length ? 2 * Math.PI : 0);
		return [o, ray(a), ray((a + b) / 2), ray(b)];
	});
}

/** the plane cut into parallel bands at offsets along n, far away */
function bands(o: Vec2, n: Vec2, offsets: number[], far: number): Vec2[][] {
	const t: Vec2 = [-n[1], n[0]];
	const at = (s: number, r: number): Vec2 => [
		o[0] + s * n[0] + r * t[0],
		o[1] + s * n[1] + r * t[1]
	];
	const cuts = [-far, ...offsets, far];
	return cuts
		.slice(1)
		.map((s, k) => [at(cuts[k], -far), at(s, -far), at(s, far), at(cuts[k], far)]);
}

/** vertices as the gpu reads them */
const rounded = (pieces: Vec2[][]) => pieces.map((v) => v.map((q) => q.map(Math.fround) as Vec2));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const normalise = (xs: number[]) => xs.map((x) => x / sum(xs));
const variation = (a: number[], b: number[]) => 0.5 * sum(a.map((x, k) => Math.abs(x - b[k])));

describe('coverage', () => {
	it('has its normal cdf within the erf allocation', async () => {
		const ts = Array.from({ length: 4001 }, (_, i) => -8 + i * 0.004);
		const { results, over } = await run(
			{ stride: 1, out: 1, body: 'put(0u, coverage_cdf(c(0u)));' },
			pack(ts.map((t) => [t]))
		);
		// erf(x) = 2 Φ(x √2) - 1
		const worst = Math.max(...ts.map((t, i) => 2 * Math.abs(results[i] - ref.cdf(t))));
		expect(worst).toBeLessThan(1e-6);
		expect(over).toBe(0);
	});

	it('factors covariance(): b b^T + low is its a b c', async () => {
		const next = random(1);
		const view = rotation(next);
		const uniforms = new Float32Array(FRAME_UNIFORM_BYTES / 4);
		uniforms.set([...view.slice(0, 3), 0, ...view.slice(3, 6), 0, ...view.slice(6, 9), 0], 0);
		uniforms[15] = 1;
		uniforms.set([1200, 900], 78);
		uniforms[82] = LOW_PASS;
		const cases = Array.from({ length: 256 }, () => {
			const g = Array.from({ length: 4 }, () => Math.floor(next() * 2 ** 32));
			const a = 2 * Math.PI * next();
			const scale = [0, 1, 2].map(() => Math.exp(6 * next() - 5));
			const depth = 1 + 200 * next();
			return {
				g,
				rest: [
					Math.cos(a),
					Math.sin(a),
					...scale,
					depth * (next() - 0.5),
					depth * (next() - 0.5),
					-depth
				]
			};
		});
		const words = new Uint32Array(cases.length * 12);
		cases.forEach(({ g, rest }, i) => {
			words.set(g, i * 12);
			words.set(new Uint32Array(new Float32Array(rest).buffer), i * 12 + 4);
		});
		const { results } = await run(
			{
				stride: 12,
				out: 10,
				body: `let g = vec4u(w(0u), w(1u), w(2u), w(3u));
	let by = vec2f(c(4u), c(5u));
	let scale = vec3f(c(6u), c(7u), c(8u));
	let viewPos = vec3f(c(9u), c(10u), c(11u));
	let k = coverage_of(g, by, scale, viewPos);
	for (var j = 0u; j < 3u; j++) {
		put(2u * j, k.b[j].x);
		put(2u * j + 1u, k.b[j].y);
	}
	put(6u, k.low);
	let cov = covariance(g, by, scale, viewPos);
	put(7u, cov.x);
	put(8u, cov.y);
	put(9u, cov.z);`
			},
			words,
			{ uniforms }
		);
		for (let i = 0; i < cases.length; i++) {
			const r = results.subarray(i * 10, i * 10 + 10);
			const b = [r.subarray(0, 2), r.subarray(2, 4), r.subarray(4, 6)];
			const a = sum(b.map((x) => x[0] * x[0])) + r[6];
			const ab = sum(b.map((x) => x[0] * x[1]));
			const cc = sum(b.map((x) => x[1] * x[1])) + r[6];
			const size = Math.max(r[7], r[9]);
			expect(r[6]).toBe(Math.fround(LOW_PASS));
			expect(Math.abs(a - r[7])).toBeLessThan(1e-5 * size);
			expect(Math.abs(ab - r[8])).toBeLessThan(1e-5 * size);
			expect(Math.abs(cc - r[9])).toBeLessThan(1e-5 * size);
		}
	});
});

/** a random rotation's rows, row-major: a unit quaternion's matrix */
function rotation(next: () => number): number[] {
	const q = [0, 1, 2, 3].map(() => next() - 0.5);
	const [w, x, y, z] = q.map((v) => v / Math.hypot(...q));
	return [
		[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
		[2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
		[2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]
	].flat();
}

const POSTERIOR: Kernel = {
	stride: 9,
	out: 12,
	body: `let k = Coverage(mat3x2f(c(0u), c(1u), c(2u), c(3u), c(4u), c(5u)), c(6u));
	let p = posterior(k, vec2f(c(7u), c(8u)));
	for (var j = 0u; j < 3u; j++) {
		put(j, p.mean[j]);
		put(3u + 3u * j, p.cov[j].x);
		put(4u + 3u * j, p.cov[j].y);
		put(5u + 3u * j, p.cov[j].z);
	}`
};

/** projections of every rank: general, a surfel, rank 1 and 0, and far larger than a screen */
function projections(next: () => number): ref.Coverage[] {
	const axis = (size: number): Vec2 => {
		const a = 2 * Math.PI * next();
		return [size * Math.cos(a), size * Math.sin(a)];
	};
	const size = () => Math.exp(8 * next() - 3);
	const scaled = (v: Vec2, k: number): Vec2 => [v[0] * k, v[1] * k];
	return Array.from({ length: 1000 }, (_, i) => {
		const low = LOW_PASS * Math.exp(4 * next() - 1);
		const b0 = axis(size());
		switch (i % 5) {
			case 0:
				return { b: [b0, axis(size()), axis(size())], low };
			case 1:
				return { b: [b0, axis(size()), axis(1e-4 * size())], low };
			case 2:
				return { b: [b0, scaled(b0, 2 * next() - 1), [0, 0]], low };
			case 3:
				return {
					b: [
						[0, 0],
						[0, 0],
						[0, 0]
					],
					low
				};
			default:
				return { b: [axis(1e4 * next()), axis(1e4 * next()), axis(10)], low };
		}
	});
}

/** an offset inside the 3 sigma ellipse of b b^T + low, where the raster draws */
function drawn(k: ref.Coverage, next: () => number): Vec2 {
	const c00 = sum(k.b.map((b) => b[0] * b[0])) + k.low;
	const c01 = sum(k.b.map((b) => b[0] * b[1]));
	const c11 = sum(k.b.map((b) => b[1] * b[1])) + k.low;
	const l00 = Math.sqrt(c00);
	const l10 = c01 / l00;
	const l11 = Math.sqrt(c11 - l10 * l10);
	const [a, r] = [2 * Math.PI * next(), 3 * Math.sqrt(next())];
	const [u, v] = [r * Math.cos(a), r * Math.sin(a)];
	return [l00 * u, l10 * u + l11 * v];
}

const f32 = (k: ref.Coverage): ref.Coverage => ({
	b: k.b.map(([x, y]) => [Math.fround(x), Math.fround(y)]) as ref.Coverage['b'],
	low: Math.fround(k.low)
});

/** each case's posterior, read back */
async function posteriors(ks: ref.Coverage[], xs: Vec2[]): Promise<Posterior[]> {
	const { results, over } = await run(
		POSTERIOR,
		pack(ks.map((k, i) => [...k.b.flat(), k.low, ...xs[i]]))
	);
	expect(over).toBe(0);
	return ks.map((_, i) => {
		const r = [...results.subarray(i * 12, i * 12 + 12)];
		return {
			mean: r.slice(0, 3) as Vec3,
			cov: [0, 1, 2].map((j) => r.slice(3 + 3 * j, 6 + 3 * j)) as Posterior['cov']
		};
	});
}

describe('posterior', () => {
	it('matches the textbook posterior where the raster draws', async () => {
		const next = random(2);
		const ks = projections(next).map(f32);
		const xs = ks.map((k) => drawn(k, next).map(Math.fround) as Vec2);
		const got = await posteriors(ks, xs);
		ks.forEach((k, i) => {
			const want = ref.posterior(k, xs[i]);
			for (let j = 0; j < 3; j++) {
				const sigma = Math.sqrt(want.cov[j][j]);
				expect(Math.abs(got[i].mean[j] - want.mean[j])).toBeLessThan(5e-3 * sigma);
				for (let l = 0; l < 3; l++)
					expect(Math.abs(got[i].cov[j][l] - want.cov[j][l])).toBeLessThan(1e-6);
			}
		});
	});

	it('keeps the prior along a collapsed projection', async () => {
		const ks: ref.Coverage[] = [
			{
				b: [
					[0, 0],
					[0, 0],
					[0, 0]
				],
				low: LOW_PASS
			},
			{
				b: [
					[8, 6],
					[0, 0],
					[0, 0]
				],
				low: LOW_PASS
			},
			{
				b: [
					[8, 6],
					[-4, -3],
					[0, 0]
				],
				low: LOW_PASS
			}
		];
		const [none, one, parallel] = await posteriors(ks, [
			[3, -2],
			[3, -2],
			[3, -2]
		]);
		const near = (got: number[], want: number[]) =>
			got.forEach((x, i) => expect(Math.abs(x - want[i])).toBeLessThan(1e-6));
		near([...none.mean, ...none.cov.flat()], [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]);
		// rank 1 along axis 0: axes 1 and 2 untouched
		near([one.mean[1], one.mean[2], one.cov[1][1], one.cov[2][2], one.cov[1][2]], [0, 0, 1, 1, 0]);
		// axes 0 and 1 drawn on one line: nothing learnt along (1, 2) / √5 or axis 2
		const along = (p: Posterior, u: Vec3) =>
			sum([0, 1, 2].map((i) => sum([0, 1, 2].map((j) => u[i] * p.cov[i][j] * u[j]))));
		near([along(parallel, [1 / Math.sqrt(5), 2 / Math.sqrt(5), 0]), parallel.cov[2][2]], [1, 1]);
	});

	it('stays finite far off a splat and far larger than the screen', async () => {
		const ks: ref.Coverage[] = [
			{
				b: [
					[3, 1],
					[-1, 2],
					[0.01, 0]
				],
				low: LOW_PASS
			},
			{
				b: [
					[3, 1],
					[6, 2],
					[0, 0]
				],
				low: LOW_PASS
			},
			{
				b: [
					[2e5, 1e5],
					[-1e5, 3e5],
					[10, 0]
				],
				low: LOW_PASS
			}
		];
		const got = await posteriors(ks, [
			[1e6, -1e6],
			[1e6, -1e6],
			[2e5, -3e5]
		]);
		for (const p of got) expect([...p.mean, ...p.cov.flat()].every(Number.isFinite)).toBe(true);
		expect(got[2].mean[0]).toBeCloseTo(ref.posterior(ks[2], [2e5, -3e5]).mean[0], 3);
	});
});

const HALFPLANE: Kernel = {
	stride: 8,
	out: 2,
	body: `let p2 = Posterior2(vec2f(c(0u), c(1u)), mat2x2f(c(2u), c(3u), c(3u), c(4u)));
	put(0u, halfplane(p2, vec2f(c(5u), c(6u)), c(7u)));
	let p3 = Posterior(vec3f(c(0u), c(1u), 0.5), mat3x3f(c(2u), c(3u), 0.1, c(3u), c(4u), -0.2, 0.1, -0.2, 0.7));
	put(1u, halfspace(p3, vec3f(c(5u), c(6u), 0.3), c(7u)));`
};

describe('halfspace and halfplane', () => {
	it('are the normal cdf of the signed distance', async () => {
		const next = random(4);
		const cases = Array.from({ length: 1000 }, () => {
			const p = posterior2(next);
			const [a, d] = [2 * Math.PI * next(), 8 * next() - 4];
			return [...p.mean, p.cov[0][0], p.cov[0][1], p.cov[1][1], Math.cos(a), Math.sin(a), d].map(
				Math.fround
			);
		});
		const { results, over } = await run(HALFPLANE, pack(cases));
		expect(over).toBe(0);
		cases.forEach(([m0, m1, c00, c01, c11, n0, n1, d], i) => {
			const p2: Posterior2 = {
				mean: [m0, m1],
				cov: [
					[c00, c01],
					[c01, c11]
				]
			};
			const p3: Posterior = {
				mean: [m0, m1, 0.5],
				cov: [
					[c00, c01, 0.1],
					[c01, c11, -0.2],
					[0.1, -0.2, 0.7]
				].map((r) => r.map(Math.fround)) as Posterior['cov']
			};
			expect(Math.abs(results[2 * i] - ref.halfplane(p2, [n0, n1], d))).toBeLessThan(1e-6);
			expect(
				Math.abs(results[2 * i + 1] - ref.halfspace(p3, [n0, n1, Math.fround(0.3)], d))
			).toBeLessThan(1e-6);
		});
	});

	it('take a pinned posterior as a step', async () => {
		const cases = [
			[0.5, 0, 0, 0, 0, 1, 0, -0.5],
			[0.5, 0, 0, 0, 0, 1, 0, -0.6],
			[0.5, 0, 1, 0, 1, 0, 0, -1]
		];
		const { results } = await run(HALFPLANE, pack(cases));
		expect([results[0], results[2], results[4]]).toEqual([1, 0, 0]);
	});
});

describe('polygon', () => {
	it('integrates within the tail and the estimate, as the float64 algorithm does', async () => {
		const next = random(5);
		const cases = Array.from({ length: 600 }, (): [Posterior2, Vec2[]] => {
			const p = posterior2(next);
			return [p, polygonNear(next, p)];
		});
		const { results, over } = await polygons(cases);
		expect(over).toBe(0);
		cases.forEach(([p, v], i) => {
			const mirror = ref.polygon(p, v);
			expect(Math.abs(results[i] - ref.dense(p, v))).toBeLessThan(TAIL + ref.BUDGET);
			expect(Math.abs(results[i] - mirror.mass)).toBeLessThan(1e-5);
		});
	});

	it('has an estimate above its error on the clipped polygon', () => {
		const next = random(6);
		const unit: Posterior2 = {
			mean: [0, 0],
			cov: [
				[1, 0],
				[0, 1]
			]
		};
		for (let i = 0; i < 300; i++) {
			const p = posterior2(next);
			// half the cases wedges with long edges, whose first estimates are the largest
			const [sx, sy] = [Math.sqrt(p.cov[0][0]), Math.sqrt(p.cov[1][1])];
			const o: Vec2 = [p.mean[0] + sx * (4 * next() - 2), p.mean[1] + sy * (4 * next() - 2)];
			const a = 2 * Math.PI * next();
			const v =
				i % 2
					? polygonNear(next, p)
					: wedges(o, [a, a + 0.5 + 2.5 * next()], 50 * Math.max(sx, sy))[0];
			const r = ref.polygon(p, v);
			expect(Math.abs(r.mass - ref.dense(unit, ref.clipped(p, v)))).toBeLessThanOrEqual(
				r.error + 1e-12
			);
		}
	});

	it('is 0 for no area and outside the square', async () => {
		const unit: Posterior2 = {
			mean: [0, 0],
			cov: [
				[1, 0],
				[0, 1]
			]
		};
		const { results } = await polygons([
			[
				unit,
				[
					[-1, -1],
					[0, 0],
					[1, 1]
				]
			],
			[
				unit,
				[
					[0, 0],
					[1, 0],
					[1, 0],
					[0, 0]
				]
			],
			[
				unit,
				[
					[0, 0],
					[1, 0]
				]
			],
			[
				unit,
				[
					[3.8, -1],
					[9, -1],
					[9, 1],
					[3.8, 1]
				]
			],
			[
				unit,
				[
					[4, 4],
					[5, 4],
					[5, 5]
				]
			]
		]);
		expect(Math.max(...results.map(Math.abs))).toBeLessThan(1e-7);
		expect([...results.subarray(2)]).toEqual([0, 0, 0]);
	});

	it('is the whole mass over the square and none far off', async () => {
		const unit: Posterior2 = {
			mean: [0, 0],
			cov: [
				[1, 0],
				[0, 1]
			]
		};
		const far: Posterior2 = {
			mean: [1e6, -1e6],
			cov: [
				[1e-4, 0],
				[0, 1e-4]
			]
		};
		const big: Vec2[] = [
			[-1e4, -1e4],
			[1e4, -1e4],
			[1e4, 1e4],
			[-1e4, 1e4]
		];
		const { results } = await polygons([
			[unit, big],
			[far, big],
			[
				far,
				[
					[1e6 - 1, -1e6 - 1],
					[1e6 + 1, -1e6 - 1],
					[1e6 + 1, -1e6 + 1],
					[1e6 - 1, -1e6 + 1]
				]
			]
		]);
		const square = (1 - 2 * ref.cdf(-ref.HALF_SIDE)) ** 2;
		expect(Math.abs(results[0] - square)).toBeLessThan(1e-6);
		expect(results[1]).toBe(0);
		expect(Math.abs(results[2] - square)).toBeLessThan(1e-5);
	});
});

const CHAIN: Kernel = {
	stride: 36,
	out: 1,
	body: `let k = Coverage(mat3x2f(c(0u), c(1u), c(2u), c(3u), c(4u), c(5u)), c(6u));
	let p = marginal(posterior(k, vec2f(c(7u), c(8u))), w(9u), w(10u));
	var v: array<vec2f, 12>;
	for (var j = 0u; j < 12u; j++) {
		v[j] = vec2f(c(12u + 2u * j), c(13u + 2u * j));
	}
	put(0u, polygon(p, v, w(11u)));`
};

/** each piece's mass through posterior, marginal over axes 0 and 1, and polygon, per offset */
async function chain(k: ref.Coverage, offsets: Vec2[], pieces: Vec2[][], constants = {}) {
	const cases = offsets.flatMap((x) =>
		pieces.map((v) => [
			...k.b.flat(),
			k.low,
			...x,
			0,
			0,
			0,
			...v.flat(),
			...Array(24 - 2 * v.length).fill(0)
		])
	);
	const words = pack(cases);
	cases.forEach((_, i) => {
		words.set([0, 1, pieces[i % pieces.length].length], i * CHAIN.stride + 9);
	});
	const { results, over } = await run(CHAIN, words, { constants });
	return {
		over,
		masses: offsets.map((_, i) => [...results.subarray(i * pieces.length, (i + 1) * pieces.length)])
	};
}

/** the float64 posterior's dense masses for the same chain */
const dense = (k: ref.Coverage, x: Vec2, pieces: Vec2[][]) => {
	const p = ref.marginal(ref.posterior(k, x), 0, 1);
	return pieces.map((v) => ref.dense(p, v));
};

describe('partitions', () => {
	it('conserve mass and keep shares within the target', async () => {
		const next = random(7);
		let checked = 0;
		for (let i = 0; i < 40; i++) {
			const p = posterior2(next);
			const [sx, sy] = [Math.sqrt(p.cov[0][0]), Math.sqrt(p.cov[1][1])];
			const o: Vec2 = [p.mean[0] + sx * (3 * next() - 1.5), p.mean[1] + sy * (3 * next() - 1.5)];
			const far = 1e3 * Math.max(sx, sy);
			const a = 2 * Math.PI * next();
			const n: Vec2 = [Math.cos(a), Math.sin(a)];
			const spread = (k: number) =>
				Array.from({ length: k }, (_, j) => a + (2 * Math.PI * j) / k + 0.3 * next());
			const partitions = [
				bands(o, n, [0], far),
				wedges(o, spread(3), far),
				wedges(o, spread(4), far),
				bands(o, n, [0, 0.02 * Math.min(sx, sy)], far)
			];
			for (const pieces of partitions.map(rounded)) {
				const { results, over } = await polygons(pieces.map((v) => [p, v]));
				expect(over).toBe(0);
				const masses = [...results];
				expect(Math.abs(sum(masses) - 1)).toBeLessThan(TARGET);
				const want = normalise(pieces.map((v) => ref.dense(p, v)));
				expect(variation(normalise(masses), want)).toBeLessThan(TARGET);
				checked++;
			}
		}
		expect(checked).toBe(160);
	});

	it('move smoothly as the pixel sweeps across a junction', async () => {
		// a surfel 12 by 6 px; three owners meet near its centre
		const k: ref.Coverage = f32({
			b: [
				[12, 3],
				[-2, 6],
				[0.05, -0.02]
			],
			low: LOW_PASS
		});
		const pieces = rounded(wedges([0.3, -0.2], [0.4, 2.3, 4.1], 1e3));
		const centre: Vec2 = [12 * 0.3 - 2 * -0.2, 3 * 0.3 + 6 * -0.2];
		const offsets = Array.from({ length: 401 }, (_, i): Vec2 => {
			const s = -20 + 0.1 * i;
			return [Math.fround(centre[0] + 0.8 * s), Math.fround(centre[1] + 0.6 * s)];
		});
		const { over, masses } = await chain(k, offsets, pieces);
		expect(over).toBe(0);
		const want = offsets.map((x) => normalise(dense(k, x, pieces)));
		const got = masses.map(normalise);
		got.forEach((s, i) => {
			expect(variation(s, want[i])).toBeLessThan(TARGET);
			if (i > 0) {
				for (let j = 0; j < 3; j++) {
					const jump = s[j] - got[i - 1][j] - (want[i][j] - want[i - 1][j]);
					expect(Math.abs(jump)).toBeLessThan(ref.BUDGET);
				}
			}
		});
	});
});

describe('coverage_over', () => {
	it('counts each sample over the budget after the halvings, once', async () => {
		const unit: Posterior2 = {
			mean: [0, 0],
			cov: [
				[1, 0],
				[0, 1]
			]
		};
		// diagonal half-planes: their first estimates are the largest a polygon has
		const cases = Array.from({ length: 64 }, (_, i): [Posterior2, Vec2[]] => {
			const d = -2 + i / 16;
			return [
				unit,
				[
					[d - 50, d + 50],
					[d + 50, d - 50],
					[d + 50, d + 50]
				]
			];
		});
		const forced = await polygons(cases, { coverage_budget: -1 });
		expect(forced.over).toBe(cases.length);
		const plain = await polygons(cases);
		expect(plain.over).toBe(0);
		// the halvings it was forced through moved no mass
		cases.forEach((_, i) =>
			expect(Math.abs(forced.results[i] - plain.results[i])).toBeLessThan(1e-5)
		);
	});
});

describe('cost', () => {
	it('spends 150 erf calls over 5 intervals, no halving, at a three-owner junction', () => {
		const k: ref.Coverage = {
			b: [
				[12, 3],
				[-2, 6],
				[0.05, -0.02]
			],
			low: LOW_PASS
		};
		// the pixel over the junction
		const p = ref.marginal(ref.posterior(k, [4, -0.3]), 0, 1);
		const spent = wedges([0.3, -0.2], [0.4, 2.3, 4.1], 1e3).map((v) => ref.polygon(p, v));
		const intervals = sum(spent.map((r) => r.intervals));
		expect(sum(spent.map((r) => r.erfs))).toBe(30 * intervals);
		expect(intervals).toBe(5);
	});
});
