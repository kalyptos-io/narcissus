// stand-in for the coverage library until it lands: the shapes and signatures, no mass

struct Coverage {
	b: mat3x2f,
	low: f32,
}

struct Posterior {
	mean: vec3f,
	covariance: mat3x3f,
}

struct Posterior2 {
	mean: vec2f,
	covariance: mat2x2f,
}

fn coverage_of(g: vec4u, by: vec2f, scale: vec3f, viewPos: vec3f) -> Coverage {
	return Coverage(mat3x2f(), uniforms.lowPass);
}

fn posterior(c: Coverage, offset: vec2f) -> Posterior {
	return Posterior(vec3f(0.0), mat3x3f(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0));
}

fn marginal(p: Posterior, a: u32, b: u32) -> Posterior2 {
	return Posterior2(vec2f(p.mean[a], p.mean[b]), mat2x2f(1.0, 0.0, 0.0, 1.0));
}

fn halfspace(p: Posterior, n: vec3f, d: f32) -> f32 {
	return 1.0;
}

fn halfplane(p: Posterior2, n: vec2f, d: f32) -> f32 {
	return 1.0;
}

fn polygon(p: Posterior2, v: array<vec2f, 12>, count: u32) -> f32 {
	coverage_over();
	return 1.0;
}
