// u[0] holds the fog colour and the start depth, u[1].x the far clip
fn fog(s: ptr<function, Splat>, u: array<vec4f, 2>) {
	let t = clamp(((*s).depth - u[0].w) / max(u[1].x - u[0].w, 1e-3), 0.0, 1.0);
	(*s).colour = mix((*s).colour, u[0].rgb, t);
}
