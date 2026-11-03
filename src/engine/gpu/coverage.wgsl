// the mass of a splat's gaussian in regions of its source coordinates, given the pixel it is drawn
// at (docs/plugins.md, Coverage); reads common.wgsl and the pass's uniforms, and the pass defines
// fn coverage_over()

// z ~ N(0, I) in sigmas along the stored scale axes, drawn at x = b z + e with e ~ N(0, low I)
struct Coverage {
	// px of one sigma along each source axis
	b: mat3x2f,
	// px²
	low: f32,
}

struct Posterior {
	mean: vec3f,
	cov: mat3x3f,
}

struct Posterior2 {
	mean: vec2f,
	cov: mat2x2f,
}

// the clip planes a splat crosses, in its source coordinates: kept where dot(xyz, z) + w >= 0, xyz
// unit, w in sigmas; those past count are unused
struct Clip {
	planes: array<vec4f, 2>,
	count: u32,
}

// whitened half-side polygon() clips to: the tail it drops is at most 4 Φ(-3.73) = 3.8e-4
const COVERAGE_SIDE: f32 = 3.73;
// halvings polygon() spends past its vertex intervals
const COVERAGE_HALVINGS: u32 = 4u;
// a 12-gon clipped to the square has at most 16 vertices
const COVERAGE_INTERVALS: u32 = 15u + COVERAGE_HALVINGS;
// tests lower it to force a sample over
override coverage_budget: f32 = 1.0 / 510.0;

// covariance()'s axes and jacobian, kept apart: b b^T + low is its a b c
fn coverage_of(g: vec4u, by: vec2f, scale: vec3f, viewPos: vec3f) -> Coverage {
	let depth = -viewPos.z;
	let r = rotate(rotation(g));
	let m = mat3x3f(turn(r[0], by) * scale.x, turn(r[1], by) * scale.y, turn(r[2], by) * scale.z);
	let w = mat3x3f(uniforms.view[0].xyz, uniforms.view[1].xyz, uniforms.view[2].xyz);
	let wm = w * m;
	let focal = uniforms.focal;
	let j0 = vec3f(focal.x / depth, 0.0, focal.x * viewPos.x / (depth * depth));
	let j1 = vec3f(0.0, focal.y / depth, focal.y * viewPos.y / (depth * depth));
	let u = j0 * wm;
	let v = j1 * wm;
	return Coverage(mat3x2f(vec2f(u.x, v.x), vec2f(u.y, v.y), vec2f(u.z, v.z)), uniforms.lowPass);
}

// z given x; the covariance as adj(b^T b + low I) / det C, so no entry is 1 less a near 1
fn posterior(c: Coverage, offset: vec2f) -> Posterior {
	let r0 = vec3f(c.b[0].x, c.b[1].x, c.b[2].x);
	let r1 = vec3f(c.b[0].y, c.b[1].y, c.b[2].y);
	let l = c.low;
	let n = cross(r0, r1);
	let sq = r0 * r0 + r1 * r1;
	let xy = -(r0.x * r0.y + r1.x * r1.y);
	let xz = -(r0.x * r0.z + r1.x * r1.z);
	let yz = -(r0.y * r0.z + r1.y * r1.z);
	// trace(b^T b) I - b^T b, its diagonal summed over the other axes
	let t = mat3x3f(sq.y + sq.z, xy, xz, xy, sq.x + sq.z, yz, xz, yz, sq.x + sq.y);
	// det C with det(b b^T) as |n|², which cancels nothing
	let d = l * l + l * (sq.x + sq.y + sq.z) + dot(n, n);
	// b^T adj(C) x, its products of nearly parallel rows folded into n
	let mean = l * (offset * c.b) + cross(offset.x * r1 - offset.y * r0, n);
	let unit = mat3x3f(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0);
	let nn = mat3x3f(n * n.x, n * n.y, n * n.z);
	return Posterior(mean / d, (l * l * unit + l * t + nn) * (1.0 / d));
}

fn marginal(p: Posterior, a: u32, b: u32) -> Posterior2 {
	let cov = mat2x2f(p.cov[a][a], p.cov[a][b], p.cov[b][a], p.cov[b][b]);
	return Posterior2(vec2f(p.mean[a], p.mean[b]), cov);
}

fn halfspace(p: Posterior, n: vec3f, d: f32) -> f32 {
	return coverage_side(dot(n, p.mean) + d, dot(n, p.cov * n));
}

fn halfplane(p: Posterior2, n: vec2f, d: f32) -> f32 {
	return coverage_side(dot(n, p.mean) + d, dot(n, p.cov * n));
}

// mass every plane of clip keeps: one plane's signed distance is gaussian, two planes' a quadrant
// of a 2d gaussian
fn clip_mass(p: Posterior, clip: Clip) -> f32 {
	if (clip.count == 0u) {
		return 1.0;
	}
	let n0 = clip.planes[0].xyz;
	let s0 = dot(n0, p.mean) + clip.planes[0].w;
	let v0 = dot(n0, p.cov * n0);
	if (clip.count == 1u) {
		return coverage_side(s0, v0);
	}
	let n1 = clip.planes[1].xyz;
	let s1 = dot(n1, p.mean) + clip.planes[1].w;
	let v1 = dot(n1, p.cov * n1);
	let c = dot(n0, p.cov * n1);
	// its open sides 8 sigmas out, past the square polygon() clips to
	let far = max(vec2f(s0, s1), vec2f(0.0)) + 8.0 * sqrt(vec2f(v0, v1));
	var v: array<vec2f, 12>;
	v[1] = vec2f(far.x, 0.0);
	v[2] = far;
	v[3] = vec2f(0.0, far.y);
	return polygon(Posterior2(vec2f(s0, s1), mat2x2f(v0, c, c, v1)), v, 4u);
}

// v[0..count) cut to where each plane of clip keeps as the marginal over axes a and b sees it: where
// the plane's signed distance, given those axes, has a mean kept; exact when the plane's normal lies
// in those axes. at most count + clip.count vertices
fn clip_polygon(
	p: Posterior,
	a: u32,
	b: u32,
	clip: Clip,
	v: ptr<function, array<vec2f, 12>>,
	count: u32
) -> u32 {
	let saa = p.cov[a][a];
	let sab = p.cov[a][b];
	let sbb = p.cov[b][b];
	let det = saa * sbb - sab * sab;
	let mean = vec2f(p.mean[a], p.mean[b]);
	var n = count;
	for (var k = 0u; k < clip.count; k++) {
		let plane = clip.planes[k];
		let q = p.cov * plane.xyz;
		// the regression of the signed distance on the two axes, times det
		let g = vec2f(sbb * q[a] - sab * q[b], saa * q[b] - sab * q[a]);
		let h = det * (dot(plane.xyz, p.mean) + plane.w) - dot(g, mean);
		n = coverage_cut(v, n, g, h);
	}
	return n;
}

// sutherland-hodgman: v[0..n) kept where dot(g, q) + h >= 0
fn coverage_cut(v: ptr<function, array<vec2f, 12>>, n: u32, g: vec2f, h: f32) -> u32 {
	var out: array<vec2f, 12>;
	var m = 0u;
	for (var i = 0u; i < n; i++) {
		let p = (*v)[i];
		let q = (*v)[select(i + 1u, 0u, i + 1u == n)];
		let fp = dot(g, p) + h;
		let fq = dot(g, q) + h;
		if (fp >= 0.0) {
			out[m] = p;
			m++;
		}
		if ((fp >= 0.0) != (fq >= 0.0)) {
			out[m] = mix(p, q, fp / (fp - fq));
			m++;
		}
	}
	*v = out;
	return m;
}

// mass of N(s, v) at or above 0
fn coverage_side(s: f32, v: f32) -> f32 {
	if (v > 0.0) {
		return coverage_cdf(s / sqrt(v));
	}
	return select(0.0, 1.0, s >= 0.0);
}

// the standard normal cdf through erfc, abramowitz and stegun 7.1.26: |error| <= 1.5e-7 on erf
fn coverage_cdf(t: f32) -> f32 {
	let x = abs(t) * 0.7071067811865476;
	let k = 1.0 / (1.0 + 0.3275911 * x);
	let inner = 1.421413741 + k * (-1.453152027 + k * 1.061405429);
	let poly = k * (0.254829592 + k * (-0.284496736 + k * inner));
	let tail = 0.5 * poly * exp(-x * x);
	return select(tail, 1.0 - tail, t >= 0.0);
}

fn polygon(p: Posterior2, v: array<vec2f, 12>, count: u32) -> f32 {
	let n = min(count, 12u);
	if (n < 3u) {
		return 0.0;
	}
	// whiten by the cholesky factor; the floor holds the conditional sigma to 1e-3 of the marginal
	let a = sqrt(max(p.cov[0][0], 1e-30));
	let b = p.cov[0][1] / a;
	let c = sqrt(max(max(p.cov[1][1] - b * b, 1e-6 * p.cov[1][1]), 1e-30));
	var vertices = v;
	var w: array<vec2f, 16>;
	for (var i = 0u; i < n; i++) {
		let d = vertices[i] - p.mean;
		let x = d.x / a;
		w[i] = vec2f(x, (d.y - b * x) / c);
	}
	var m = coverage_clip(&w, n, 0u, 1.0);
	m = coverage_clip(&w, m, 0u, -1.0);
	m = coverage_clip(&w, m, 1u, 1.0);
	m = coverage_clip(&w, m, 1u, -1.0);
	if (m < 3u) {
		return 0.0;
	}

	// vertex intervals
	var xs: array<f32, 16>;
	for (var i = 0u; i < m; i++) {
		var j = i;
		for (; j > 0u && xs[j - 1u] > w[i].x; j--) {
			xs[j] = xs[j - 1u];
		}
		xs[j] = w[i].x;
	}
	var list: array<CoverageInterval, COVERAGE_INTERVALS>;
	var intervals = 0u;
	for (var k = 0u; k + 1u < m; k++) {
		let u = vec2f(xs[k], xs[k + 1u]);
		if (u.y > u.x) {
			list[intervals] = coverage_rule(u, coverage_chains(&w, m, u));
			intervals++;
		}
	}

	// halve the worst
	var error = coverage_error(&list, intervals);
	for (var h = 0u; h < COVERAGE_HALVINGS && error > coverage_budget; h++) {
		var worst = 0u;
		for (var k = 1u; k < intervals; k++) {
			if (list[k].error > list[worst].error) {
				worst = k;
			}
		}
		let it = list[worst];
		let u = 0.5 * (it.u.x + it.u.y);
		let mid = 0.5 * (it.chains.xz + it.chains.yw);
		let left = vec4f(it.chains.x, mid.x, it.chains.z, mid.y);
		let right = vec4f(mid.x, it.chains.y, mid.y, it.chains.w);
		list[worst] = coverage_rule(vec2f(it.u.x, u), left);
		list[intervals] = coverage_rule(vec2f(u, it.u.y), right);
		intervals++;
		error = coverage_error(&list, intervals);
	}
	if (error > coverage_budget) {
		coverage_over();
	}
	var mass = 0.0;
	for (var k = 0u; k < intervals; k++) {
		mass += list[k].mass;
	}
	return mass;
}

// one interval of u and its chains: lower v at either end, then upper
struct CoverageInterval {
	u: vec2f,
	chains: vec4f,
	mass: f32,
	error: f32,
}

// sutherland-hodgman: w[0..n) kept where sign * w[axis] <= COVERAGE_SIDE, cuts set on the line
fn coverage_clip(w: ptr<function, array<vec2f, 16>>, n: u32, axis: u32, sign: f32) -> u32 {
	var out: array<vec2f, 16>;
	var m = 0u;
	for (var i = 0u; i < n; i++) {
		let p = (*w)[i];
		let q = (*w)[select(i + 1u, 0u, i + 1u == n)];
		let inP = sign * p[axis] <= COVERAGE_SIDE;
		let inQ = sign * q[axis] <= COVERAGE_SIDE;
		if (inP) {
			out[m] = p;
			m++;
		}
		if (inP != inQ) {
			var cut = mix(p, q, (sign * COVERAGE_SIDE - p[axis]) / (q[axis] - p[axis]));
			cut[axis] = sign * COVERAGE_SIDE;
			out[m] = cut;
			m++;
		}
	}
	*w = out;
	return m;
}

// the lower and upper edges over the middle of u, each read at both ends; nothing when rounding
// leaves no edge across a sliver
fn coverage_chains(w: ptr<function, array<vec2f, 16>>, m: u32, u: vec2f) -> vec4f {
	let mid = 0.5 * (u.x + u.y);
	var chains = vec4f(COVERAGE_SIDE, COVERAGE_SIDE, -COVERAGE_SIDE, -COVERAGE_SIDE);
	for (var i = 0u; i < m; i++) {
		let p = (*w)[i];
		let q = (*w)[select(i + 1u, 0u, i + 1u == m)];
		let ends = p.y + (q.y - p.y) * ((u - p.x) / (q.x - p.x));
		if (p.x < mid && mid < q.x) {
			chains.x = ends.x;
			chains.y = ends.y;
		}
		if (q.x < mid && mid < p.x) {
			chains.z = ends.x;
			chains.w = ends.y;
		}
	}
	return chains;
}

const COVERAGE_XK = array<f32, 8>(
	0.991455371120813, 0.949107912342759, 0.864864423359769, 0.741531185599394,
	0.586087235467691, 0.405845151377397, 0.207784955007898, 0.0
);
const COVERAGE_WK = array<f32, 8>(
	0.02293532201052922, 0.06309209262997855, 0.1047900103222502, 0.1406532597155259,
	0.1690047266392679, 0.1903505780647854, 0.2044329400752989, 0.2094821410847278
);
// gauss 7 on the odd kronrod nodes, then the centre
const COVERAGE_WG = array<f32, 4>(
	0.1294849661688697, 0.2797053914892767, 0.3818300505051189, 0.4179591836734694
);

// kronrod 15 over the interval, its error |k15 - g7|
fn coverage_rule(u: vec2f, chains: vec4f) -> CoverageInterval {
	let centre = coverage_strip(u, chains, 0.0);
	var k = COVERAGE_WK[7] * centre;
	var g = COVERAGE_WG[3] * centre;
	for (var j = 0u; j < 7u; j++) {
		let x = COVERAGE_XK[j];
		let pair = coverage_strip(u, chains, -x) + coverage_strip(u, chains, x);
		k += COVERAGE_WK[j] * pair;
		if ((j & 1u) == 1u) {
			g += COVERAGE_WG[j >> 1u] * pair;
		}
	}
	let half = 0.5 * (u.y - u.x);
	return CoverageInterval(u, chains, half * k, half * abs(k - g));
}

// φ(u) [Φ(upper) - Φ(lower)] at t of [-1, 1] across the interval
fn coverage_strip(u: vec2f, chains: vec4f, t: f32) -> f32 {
	let s = 0.5 + 0.5 * t;
	let x = mix(u.x, u.y, s);
	let lower = mix(chains.x, chains.y, s);
	let upper = mix(chains.z, chains.w, s);
	let band = max(coverage_cdf(upper) - coverage_cdf(lower), 0.0);
	return 0.3989422804014327 * exp(-0.5 * x * x) * band;
}

fn coverage_error(list: ptr<function, array<CoverageInterval, COVERAGE_INTERVALS>>, n: u32) -> f32 {
	var error = 0.0;
	for (var k = 0u; k < n; k++) {
		error += (*list)[k].error;
	}
	return error;
}
