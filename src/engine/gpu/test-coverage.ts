// coverage.wgsl in float64: its algorithm step for step, and the independent references it is
// tested against

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

/** B as coverage.wgsl's mat3x2f: one screen offset in px per source axis */
export interface Coverage {
	b: [Vec2, Vec2, Vec2];
	low: number;
}

export interface Posterior {
	mean: Vec3;
	cov: [Vec3, Vec3, Vec3];
}

export interface Posterior2 {
	mean: Vec2;
	cov: [Vec2, Vec2];
}

/** polygon()'s mass, its error estimate and whether it ended over its budget */
export interface Integrated {
	mass: number;
	error: number;
	over: boolean;
}

/** coverage.wgsl's constants */
export const HALF_SIDE = 3.73;
export const BUDGET = 1 / 510;
export const HALVINGS = 4;
export const VERTICES = 12;

// erf to 1e-15, a series near 0 and a continued fraction for erfc beyond
export function erf(x: number): number {
	const a = Math.abs(x);
	if (a < 2.5) {
		let term = a;
		let sum = a;
		for (let n = 1; Math.abs(term) > 1e-17 * Math.abs(sum); n++) {
			term *= (-a * a) / n;
			sum += term / (2 * n + 1);
		}
		return Math.sign(x) * ((2 / Math.sqrt(Math.PI)) * sum);
	}
	let f = a;
	for (let n = 60; n > 0; n--) f = a + n / 2 / f;
	return Math.sign(x) * (1 - Math.exp(-a * a) / Math.sqrt(Math.PI) / f);
}

export const cdf = (t: number) => 0.5 * (1 + erf(t / Math.SQRT2));
const pdf = (t: number) => Math.exp(-0.5 * t * t) / Math.sqrt(2 * Math.PI);

/** the textbook posterior: mean B^T C^-1 x, covariance I - B^T C^-1 B */
export function posterior(c: Coverage, x: Vec2): Posterior {
	const [b0, b1, b2] = c.b;
	const rows = [
		[b0[0], b1[0], b2[0]],
		[b0[1], b1[1], b2[1]]
	];
	const dot = (p: number[], q: number[]) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
	const c00 = dot(rows[0], rows[0]) + c.low;
	const c01 = dot(rows[0], rows[1]);
	const c11 = dot(rows[1], rows[1]) + c.low;
	const det = c00 * c11 - c01 * c01;
	const inv = [
		[c11 / det, -c01 / det],
		[-c01 / det, c00 / det]
	];
	// k = B^T C^-1, 3 x 2
	const k = [0, 1, 2].map((i) =>
		[0, 1].map((j) => rows[0][i] * inv[0][j] + rows[1][i] * inv[1][j])
	);
	const mean = k.map((ki) => ki[0] * x[0] + ki[1] * x[1]) as Vec3;
	const cov = k.map((ki, i) =>
		[0, 1, 2].map((j) => (i === j ? 1 : 0) - ki[0] * rows[0][j] - ki[1] * rows[1][j])
	) as Posterior['cov'];
	return { mean, cov };
}

export function marginal(p: Posterior, a: number, b: number): Posterior2 {
	return {
		mean: [p.mean[a], p.mean[b]],
		cov: [
			[p.cov[a][a], p.cov[a][b]],
			[p.cov[b][a], p.cov[b][b]]
		]
	};
}

/** mass where dot(n, z) + d >= 0, exactly */
export function halfspace(p: Posterior, n: Vec3, d: number): number {
	const s = n[0] * p.mean[0] + n[1] * p.mean[1] + n[2] * p.mean[2] + d;
	let v = 0;
	for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) v += n[i] * p.cov[i][j] * n[j];
	return v > 0 ? cdf(s / Math.sqrt(v)) : Number(s >= 0);
}

export function halfplane(p: Posterior2, n: Vec2, d: number): number {
	const s = n[0] * p.mean[0] + n[1] * p.mean[1] + d;
	const v = n[0] * n[0] * p.cov[0][0] + 2 * n[0] * n[1] * p.cov[0][1] + n[1] * n[1] * p.cov[1][1];
	return v > 0 ? cdf(s / Math.sqrt(v)) : Number(s >= 0);
}

/** the convex polygon v in the posterior's whitened coordinates, by its cholesky factor */
function whiten(p: Posterior2, v: Vec2[]): Vec2[] {
	const a = Math.sqrt(p.cov[0][0]);
	const b = p.cov[0][1] / a;
	const c = Math.sqrt(p.cov[1][1] - b * b);
	return v.map(([x, y]) => {
		const u = (x - p.mean[0]) / a;
		return [u, (y - p.mean[1] - b * u) / c];
	});
}

/** for a convex counter-clockwise polygon, its lower and upper chains' v at u */
function chains(w: Vec2[], u: number): [number, number] {
	let lo = -Infinity;
	let up = Infinity;
	for (let i = 0; i < w.length; i++) {
		const [x0, y0] = w[i];
		const [x1, y1] = w[(i + 1) % w.length];
		if (x0 === x1 || u < Math.min(x0, x1) || u > Math.max(x0, x1)) continue;
		const y = y0 + ((y1 - y0) * (u - x0)) / (x1 - x0);
		if (x1 > x0) lo = Math.max(lo, y);
		else up = Math.min(up, y);
	}
	return [lo, up];
}

/** the polygon's mass by fine quadrature: no clipping, 64 x 16-point gauss-legendre a vertex
 * interval within 12 sigmas */
export function dense(p: Posterior2, v: Vec2[]): number {
	const w = whiten(p, v);
	const xs = [...new Set(w.map((q) => Math.min(12, Math.max(-12, q[0]))))].sort((a, b) => a - b);
	let mass = 0;
	for (let k = 0; k + 1 < xs.length; k++) {
		const h = (xs[k + 1] - xs[k]) / 64;
		for (let s = 0; s < 64; s++) {
			const mid = xs[k] + (s + 0.5) * h;
			for (let g = 0; g < 16; g++) {
				const u = mid + 0.5 * h * GL16[g][0];
				const [lo, up] = chains(w, u);
				if (up > lo) mass += 0.5 * h * GL16[g][1] * pdf(u) * (cdf(up) - cdf(lo));
			}
		}
	}
	return mass;
}

// gauss-legendre 16 on [-1, 1]: nodes and weights, both signs
const GL16: Vec2[] = [
	[0.0950125098376374, 0.1894506104550685],
	[0.2816035507792589, 0.1826034150449236],
	[0.4580167776572274, 0.1691565193950025],
	[0.6178762444026438, 0.149595988816577],
	[0.755404408355003, 0.1246289712555339],
	[0.8656312023878318, 0.0951585116824928],
	[0.9445750230732326, 0.0622535239386479],
	[0.9894009349916499, 0.0271524594117541]
].flatMap(([x, w]) => [[x, w] as Vec2, [-x, w] as Vec2]);

// kronrod 15 nodes on [0, 1] of [-1, 1], their weights, and gauss 7's on the odd ones
const XK = [
	0.9914553711208126, 0.9491079123427585, 0.8648644233597691, 0.7415311855993945,
	0.5860872354676911, 0.4058451513773972, 0.20778495500789848, 0
];
const WK = [
	0.022935322010529224, 0.06309209262997856, 0.10479001032225019, 0.14065325971552592,
	0.1690047266392679, 0.19035057806478542, 0.20443294007529889, 0.20948214108472782
];
const WG = [0.1294849661688697, 0.27970539148927664, 0.3818300505051189, 0.4179591836734694];

interface Interval {
	u: Vec2;
	lo: Vec2;
	up: Vec2;
	mass: number;
	error: number;
}

/** coverage.wgsl's polygon(): whiten, clip to the square, vertex intervals, adaptive k15 */
export function polygon(p: Posterior2, v: Vec2[], budget = BUDGET): Integrated {
	const none = { mass: 0, error: 0, over: false };
	if (v.length < 3) return none;
	const w = clipped(p, v);
	if (w.length < 3) return none;
	const xs = w.map((q) => q[0]).sort((a, b) => a - b);
	const list: Interval[] = [];
	for (let k = 0; k + 1 < xs.length; k++) {
		const [u0, u1] = [xs[k], xs[k + 1]];
		if (!(u1 > u0)) continue;
		const [lo0, up0] = edgeAt(w, 0.5 * (u0 + u1), u0);
		const [lo1, up1] = edgeAt(w, 0.5 * (u0 + u1), u1);
		list.push(rule([u0, u1], [lo0, lo1], [up0, up1]));
	}
	const total = () => list.reduce((s, i) => s + i.error, 0);
	for (let h = 0; h < HALVINGS && total() > budget; h++) {
		const worst = list.reduce((m, i, k) => (i.error > list[m].error ? k : m), 0);
		const { u, lo, up } = list[worst];
		const um = 0.5 * (u[0] + u[1]);
		const [lm, upm] = [0.5 * (lo[0] + lo[1]), 0.5 * (up[0] + up[1])];
		list[worst] = rule([u[0], um], [lo[0], lm], [up[0], upm]);
		list.push(rule([um, u[1]], [lm, lo[1]], [upm, up[1]]));
	}
	const error = total();
	return {
		mass: list.reduce((s, i) => s + i.mass, 0),
		error,
		over: error > budget
	};
}

/** the polygon whitened as polygon() does and clipped to the square */
export const clipped = (p: Posterior2, v: Vec2[]) => clip(whitenFloored(p, v.slice(0, VERTICES)));

/** whiten() with coverage.wgsl's floor on the conditional variance */
function whitenFloored(p: Posterior2, v: Vec2[]): Vec2[] {
	const a = Math.sqrt(Math.max(p.cov[0][0], 1e-30));
	const b = p.cov[0][1] / a;
	const c = Math.sqrt(Math.max(p.cov[1][1] - b * b, 1e-6 * p.cov[1][1], 1e-30));
	return v.map(([x, y]) => {
		const u = (x - p.mean[0]) / a;
		return [u, (y - p.mean[1] - b * u) / c];
	});
}

/** sutherland-hodgman against the square of HALF_SIDE */
function clip(w: Vec2[]): Vec2[] {
	let out = w;
	for (const [axis, sign] of [
		[0, 1],
		[0, -1],
		[1, 1],
		[1, -1]
	]) {
		const inside = (q: Vec2) => sign * q[axis] <= HALF_SIDE;
		const next: Vec2[] = [];
		for (let i = 0; i < out.length; i++) {
			const p = out[i];
			const q = out[(i + 1) % out.length];
			if (inside(p)) next.push(p);
			if (inside(p) !== inside(q)) {
				const t = (sign * HALF_SIDE - p[axis]) / (q[axis] - p[axis]);
				const cut: Vec2 = [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
				cut[axis] = sign * HALF_SIDE;
				next.push(cut);
			}
		}
		out = next;
	}
	return out;
}

/** the lower and upper edges over um, each read at u; none across a sliver */
function edgeAt(w: Vec2[], um: number, u: number): Vec2 {
	let lo = HALF_SIDE;
	let up = -HALF_SIDE;
	for (let i = 0; i < w.length; i++) {
		const [x0, y0] = w[i];
		const [x1, y1] = w[(i + 1) % w.length];
		const y = y0 + (y1 - y0) * ((u - x0) / (x1 - x0));
		if (x0 < um && um < x1) lo = y;
		if (x1 < um && um < x0) up = y;
	}
	return [lo, up];
}

/** k15 over one interval, its error |k15 - g7| */
function rule(u: Vec2, lo: Vec2, up: Vec2): Interval {
	const half = 0.5 * (u[1] - u[0]);
	const f = (t: number) => {
		const s = 0.5 * (1 + t);
		const x = u[0] + s * (u[1] - u[0]);
		const a = lo[0] + s * (lo[1] - lo[0]);
		const b = up[0] + s * (up[1] - up[0]);
		return pdf(x) * Math.max(cdf(b) - cdf(a), 0);
	};
	const centre = f(0);
	let k = WK[7] * centre;
	let g = WG[3] * centre;
	for (let j = 0; j < 7; j++) {
		const pair = f(-XK[j]) + f(XK[j]);
		k += WK[j] * pair;
		if (j % 2 === 1) g += WG[(j - 1) / 2] * pair;
	}
	return { u, lo, up, mass: half * k, error: half * Math.abs(k - g) };
}
