// the one step project and pick take a splat through, so a hook sees the same record in each

// whether the splat shade() last ran on, crossing clip's planes, takes a sample record
fn asks_record(clip: Clip) -> bool {
	return sample_hook != 0u || clip.count > 0u;
}

// false where splat t of the cluster shows none of itself against clips of the frame's planes
fn show(
	cluster: Cluster,
	t: u32,
	clips: u32,
	s: ptr<function, Splat>,
	g: ptr<function, vec4u>,
	clip: ptr<function, Clip>,
	d: ptr<function, Drawn>,
	record: ptr<function, array<u32, RECORD_WORDS>>
) -> bool {
	if (!decode(cluster, t, s, g)) {
		return false;
	}
	let turned = pages[cluster.page].turn;
	if (!clip_splat(uniforms.clips, clips, *s, *g, turned, clip)) {
		return false;
	}
	shade(s);
	if (!drawn(*s, *g, turned, d)) {
		return false;
	}
	if (asks_record(*clip)) {
		let viewPos = (uniforms.view * vec4f((*s).position, 1.0)).xyz;
		*record = sample_record(*s, coverage_of(*g, turned, (*s).scale, viewPos), *clip);
	}
	return true;
}
