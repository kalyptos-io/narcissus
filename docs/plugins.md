# Plugins

A `Plugin` gets a `Host` and installs hooks: a `Shade` for each splat, a `Sample` for each pixel of the splats a shade asks for, and a `Post`, a full-screen pass after the splats. `engine.use(plugin)` installs one and returns its remover. `engine/plugins/` holds the shipped ones.

This page is the contract between the engine and its plugins. The engine knows nothing of what a plugin's attributes or tables mean.

## Host

```ts
interface Host {
	shade(hook: Shade): () => void;
	post(pass: Post): () => void;
	/** a read-only table of u32 words, readable by every hook as table(id, i) */
	table(words: number): Table;
}

interface Table {
	readonly id: number;
	/** copies words in at word offset at; uploaded before the next frame */
	write(at: number, words: Uint32Array): void;
	destroy(): void;
}
```

## Shade

```ts
interface Shade {
	name: string;
	/** vec4f slots this hook reads */
	uniforms: number;
	wgsl: string;
	/** fills out (uniforms * 4 floats) before each frame */
	update(frame: Frame, out: Float32Array): void;
	/** attribute streams this hook reads, by the name world.json declares */
	attributes?: readonly AttributeUse[];
	/** true when wgsl also defines the Sample hook <name>_sample */
	sample?: boolean;
}

interface AttributeUse {
	stream: string;
	/** the WGSL identifier: the hook reads it as attr_<as>(s) */
	as: string;
	/** what attr_<as> returns; the world's stream must widen to it */
	type: 'u32' | 'i32' | 'f32' | 'records';
	/** 1 to 4, 1 when left out */
	components?: number;
	/** a world that lacks the stream disables the hook, else its rows take the default */
	required?: boolean;
}
```

A stream of `u8`, `u16` or `u32` widens to `u32`, `i8`, `i16` or `i32` to `i32`, and `f16` or `f32` to `f32`, with the same components; `records` only to `records`. A world that declares the stream otherwise lacks it. Two hooks may read one `as` only as the same stream, type and components.

WGSL defines `fn <name>(s: ptr<function, Splat>, u: array<vec4f, <uniforms>>)`. It may change `colour`, `opacity` and `token`; opacity 0 culls the splat. Projection and pick run the same shade hooks on the same inputs.

`Splat` (common.wgsl) adds to its fields of version 1:

| field   | meaning                                              |
| ------- | ---------------------------------------------------- |
| `token` | `u32`, 0 by default; what pick reports for the splat |
| `page`  | the resident page, for attribute reads               |
| `row`   | the splat's index in its page                        |

Generated accessors, one for each `AttributeUse`:

- A fixed stream with one component: `fn attr_<as>(s: ptr<function, Splat>) -> T`, with `T` the use's `type` (narrow types widen).
- With 2 to 4 components: the matching `vec2`-`vec4`.
- A stream the world lacks reads 0, or an empty record.
- A `records` stream: `fn attr_<as>(s: ptr<function, Splat>) -> Record`, then `fn record_u32(r: Record, i: u32) -> u32` and `fn record_f16x2(r: Record, i: u32) -> vec2f` read word `i` of the record; `r.words` is its length in whole words, the last padded with 0.

`fn table(id: u32, i: u32) -> u32` reads word `i` of a host table; 0 past its end. A hook gets a table's `id` through its uniforms.

`fn source(s: ptr<function, Splat>, p: vec3f) -> vec3f` gives a point `p` of the floating-origin frame in the splat's source coordinates (see Coverage): sigmas from its centre along each of its scale axes. A shade turns a region of the world into one its sample hook integrates with it.

A shade asks for per-pixel evaluation with `fn sample_request(s: ptr<function, Splat>, data: array<u32, 8>)`: the splat then draws through the hook's `<name>_sample`, which receives `data`. A splat has at most one sample hook: the first that asks. A sample hook reads no attributes: its shade looks them up and passes them through `data`, a record as its `at` and `words`, which the sample rebuilds with `Record(c.data[0], c.data[1])` for `record_u32` and `record_f16x2`.

## Sample

WGSL defines `fn <name>_sample(c: Sample, u: array<vec4f, <uniforms>>) -> Sampled`. It runs in the raster, for each pixel of the splat, and in pick, for each probe; it must not use derivatives or `textureSample`.

```wgsl
struct Sample {
	// the pixel's centre less the splat's centre, in pixels, y up
	offset: vec2f,
	// the splat's colour (not premultiplied) and opacity after shade
	colour: vec3f,
	opacity: f32,
	// the splat's gaussian falloff at offset, times opacity, times the mass its clip keeps there:
	// what the raster would draw as alpha
	alpha: f32,
	// what the shade passed to sample_request
	data: array<u32, 8>,
	// for posterior(); see Coverage
	coverage: Coverage,
	// the clip planes the splat crosses, for clip_polygon(); see Clipping
	clip: Clip,
	page: u32,
	row: u32,
}

struct Sampled {
	// premultiplied colour and alpha; alpha at most c.alpha
	colour: vec4f,
	token: u32,
}
```

The raster blends `Sampled.colour` once with OVER, at the splat's place in the depth order. Pick applies its cumulative-opacity rule to `Sampled.colour.a` and reports `Sampled.token`; a sample with alpha 0 never yields a hit. A hook that returns `vec4f(c.colour * c.alpha, c.alpha)` draws the splat unchanged, to 1e-5 per channel.

## Coverage

The library for hooks that split a splat's contribution by where its light comes from. The raster draws a splat as the projection of its gaussian, filtered on screen:

- `z ~ N(0, I)` in source coordinates: sigma units along the splat's three scale axes, in their stored order.
- A pixel offset `x = B z + e`, with `B` the 2 × 3 map of those axes onto the screen in pixels and `e ~ N(0, L)` the screen filter. The raster's falloff is that of `N(0, B Bᵀ + L)`.

`Coverage` carries `B` and `L` for the splat, from the same decoded and quantised inputs in the raster and in pick; both reach a sample hook as f16.

```wgsl
// z given x: mean B^T C^-1 x, covariance I - B^T C^-1 B, C = B B^T + L
fn posterior(c: Coverage, offset: vec2f) -> Posterior
// the marginal over two of the three source axes, in that order
fn marginal(p: Posterior, a: u32, b: u32) -> Posterior2
// mass where dot(n, z) + d >= 0
fn halfspace(p: Posterior, n: vec3f, d: f32) -> f32
// mass where dot(n, q) + d >= 0, q in the marginal's two axes
fn halfplane(p: Posterior2, n: vec2f, d: f32) -> f32
// mass of the convex polygon v[0..count), counter-clockwise, in the marginal's two axes
fn polygon(p: Posterior2, v: array<vec2f, 12>, count: u32) -> f32
```

"Exact" means exact for this affine gaussian model, not for perspective. The numbers:

- `halfspace` and `halfplane` use the normal CDF, through an erf with an error of at most 1e-6.
- `polygon` whitens the posterior, clips the polygon to the square of half-side 3.73, and integrates `φ(u) [Φ(v_upper(u)) - Φ(v_lower(u))]` over intervals split at its vertices. Each interval uses Gauss-Kronrod 7/15. The worst interval is halved while the summed error estimate exceeds 1/510, up to a fixed cap. A sample still over the estimate counts in `engine.stats().coverageOver`.
- `clip_mass` over two planes is the quadrant of their two signed distances, a 2d gaussian: Genz's form, the product of the two sides and an integral over the arcsine of their correlation by Gauss-Legendre 6, within 1e-3 to a correlation of 0.999. It costs six exponentials and two normal cdfs a pixel, where a `polygon` spends about 150 erf calls.
- For a complete partition, a hook normalises its pieces' masses to sum to 1. The normalised share vector's total variation target is 1/255. The error estimate is an estimate, not a bound: tests check it against a dense reference.
- A query returns the absolute mass. Masses of separate conditions are never multiplied: conditions are intersected first, then integrated.

## Clipping

`engine.addClip({ planes })` ([embedding.md](embedding.md)) keeps, of every splat of the world and of layers, what lies where every plane of every clip keeps it. Against each plane, in sigmas of the splat along the plane's normal:

- A splat more than 3 inside every plane is unchanged.
- One more than 3 outside a plane is culled, in cull and project, and pick never finds it.
- One in between crosses the plane. It draws through the sample path, its alpha the posterior mass the planes keep, and carries the planes in its source coordinates to its sample hook as `c.clip`. It carries two at most; a third plane it crosses cuts it by its centre.

```wgsl
struct Clip {
	// kept where dot(xyz, z) + w >= 0: xyz unit, w in sigmas; those past count are unused
	planes: array<vec4f, 2>,
	count: u32,
}

// the posterior mass every plane of clip keeps
fn clip_mass(p: Posterior, clip: Clip) -> f32
// v[0..count) cut to where each plane keeps, as the marginal over axes a and b sees it;
// the new count, at most count + clip.count
fn clip_polygon(p: Posterior, a: u32, b: u32, clip: Clip, v: ptr<function, array<vec2f, 12>>, count: u32) -> u32
```

`c.alpha` is already clipped, so a hook that draws the splat whole, or recolours it, needs nothing more. A hook that splits the splat into regions cuts each region's polygon with `clip_polygon()` before `polygon()` and normalises the pieces to sum to 1: they are then shares of the light the clip keeps, and `c.alpha` times a share is the mass of the region and the clip together.

- `clip_mass` is exact: one plane gives the normal cdf of its signed distance, and two a quadrant of their joint gaussian, through `polygon()`.
- `clip_polygon` takes a plane where the plane's signed distance, given the marginal's two axes, has a mean the plane keeps. That is exact when the plane's normal has no part along the third axis, as for every plane across a flat splat whose thin axis is the third. Otherwise it approximates, and the normalisation keeps the result within the mass `clip_mass` gives.
- A hook's polygon has at most 10 vertices, as each plane adds one.

`engine.heights()` counts a splat only where every plane keeps its centre.

## Pick

`Hit.token` is the token of the surface sample, from the shade or the sample hook; `Hit.row` names its source: the pack, the page's blob offset and the row, `null` for a layer's splat. `Hit.object` stays the `.ids` object.

## Cost

Rows without a sample request take the projection path as in version 1, and with no sample hook or clip installed the raster draws as in version 1. A sampled row, which a hook asked for or which crosses a clip plane, adds a record of 80 bytes for the frame. The records' room is sized before dispatch: 1.5 times what the last measured frame asked, in a power of two, at most the rows of the drawn clusters. A row past it draws unsampled, or, crossing a plane that cuts its centre, not at all; `engine.stats().unsampled` counts it, and the next frame has room. Attribute streams, tables and sample records count toward the engine's stated memory.
