// a pool splat decoded and its screen covariance, shared by project and pick; each declares the
// uniforms, geometry, colours and pages bindings these read

// i8 over 127, sign-extended by extractBits on i32
fn code(word: u32, bit: u32) -> f32 {
	return f32(extractBits(i32(word), bit, 8u)) / 127.0;
}

// smallest three: w x y z with the largest at the stored index
fn rotation(g: vec4u) -> vec4f {
	let v = (vec3f(fraction(g.z, 0u), fraction(g.z, 8u), fraction(g.z, 16u)) - 0.5) * sqrt(2.0);
	let big = sqrt(max(0.0, 1.0 - dot(v, v)));
	switch extractBits(g.y, 24u, 8u) {
		case 0u: {
			return normalize(vec4f(big, v));
		}
		case 1u: {
			return normalize(vec4f(v.x, big, v.yz));
		}
		case 2u: {
			return normalize(vec4f(v.xy, big, v.z));
		}
		default: {
			return normalize(vec4f(v, big));
		}
	}
}

fn rotate(q: vec4f) -> mat3x3f {
	let w = q.x;
	let x = q.y;
	let y = q.z;
	let z = q.w;
	return mat3x3f(
		1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y + w * z), 2.0 * (x * z - w * y),
		2.0 * (x * y - w * z), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z + w * x),
		2.0 * (x * z + w * y), 2.0 * (y * z - w * x), 1.0 - 2.0 * (x * x + y * y)
	);
}

// splat t of a cluster in the floating-origin frame, its record in g; false when a mask hides it
fn decode(cluster: Cluster, t: u32, s: ptr<function, Splat>, g: ptr<function, vec4u>) -> bool {
	let page = pages[cluster.page];
	let rec = cluster.slot + t;
	*g = geometry[rec];
	let w0 = colours[rec * 3u];
	let w1 = colours[rec * 3u + 1u];
	let w2 = colours[rec * 3u + 2u];
	let i = cluster.first + t;
	let quadrant = u32(i >= page.q1) + u32(i >= page.q2) + u32(i >= page.q3);

	var d: Splat;
	let q = vec3f(f32((*g).x & 0xffffu), f32((*g).x >> 16u), f32((*g).y & 0xffffu));
	d.position = page.origin + q * page.step;
	if (masked(cluster, d.position)) {
		return false;
	}
	d.opacity = fraction((*g).y, 16u) * fraction(page.factors, 8u * quadrant);
	let level = vec3f(fraction((*g).z, 24u), fraction((*g).w, 0u), fraction((*g).w, 8u));
	d.scale = exp(mix(page.scaleMin, page.scaleMax, level));
	let dc = mix(page.dcMin, page.dcMax, vec3f(fraction(w0, 0u), fraction(w0, 8u), fraction(w0, 16u)));
	// sh[c][m] at 3c + m, gathered per m across the colours
	let k = page.shScale;
	let m0 = vec3f(code(w0, 24u), code(w1, 16u), code(w2, 8u)) * vec3f(k[0].x, k[0].w, k[1].z);
	let m1 = vec3f(code(w1, 0u), code(w1, 24u), code(w2, 16u)) * vec3f(k[0].y, k[1].x, k[1].w);
	let m2 = vec3f(code(w1, 8u), code(w2, 0u), code(w2, 24u)) * vec3f(k[0].z, k[1].y, k[2].x);
	let toward = normalize(d.position - uniforms.camera);
	d.colour = max(0.5 + C0 * dc + C1 * (-toward.y * m0 + toward.z * m1 - toward.x * m2), vec3f(0.0));
	d.depth = -(uniforms.view * vec4f(d.position, 1.0)).z;
	*s = d;
	return true;
}

// ewa: view-space covariance wm wm^T through the jacobian of the pixel projection, as a b c in px²
fn covariance(g: vec4u, scale: vec3f, viewPos: vec3f) -> vec3f {
	let depth = -viewPos.z;
	let r = rotate(rotation(g));
	let m = mat3x3f(r[0] * scale.x, r[1] * scale.y, r[2] * scale.z);
	let w = mat3x3f(uniforms.view[0].xyz, uniforms.view[1].xyz, uniforms.view[2].xyz);
	let wm = w * m;
	let focal = uniforms.focal;
	let j0 = vec3f(focal.x / depth, 0.0, focal.x * viewPos.x / (depth * depth));
	let j1 = vec3f(0.0, focal.y / depth, focal.y * viewPos.y / (depth * depth));
	let u = j0 * wm;
	let v = j1 * wm;
	return vec3f(dot(u, u) + uniforms.lowPass, dot(u, v), dot(v, v) + uniforms.lowPass);
}
