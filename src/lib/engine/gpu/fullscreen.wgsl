@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	// one triangle over the whole target
	let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
	return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}
