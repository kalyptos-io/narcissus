# Embedding the viewer

A page that embeds narcissus can add its own splats, hide parts of the world, find what is under the cursor, draw lines and markers in the scene, and steer the camera. These hooks know nothing of the page. They are on the engine and the controls, which `<narcissus-viewer>` gives as its `engine` and `controls` properties from its `start` event.

All positions that go in or come out are world coordinates as `world.json` declares them, as JavaScript numbers (float64). Inside, the engine keeps them relative to a floating origin near the camera, so a projected northing keeps its millimetres.

To replace a part of the world, combine a mask on the world with a layer:

```ts
import { encodeLayer } from '@kalyptos/narcissus';

const { pack, origin } = await encodeLayer(splats); // or a pack from a server, and its origin
const layer = await engine.addLayer({ bytes: pack }, origin);
const mask = engine.addMask({ polygon, targets: ['world'] });

// show the original again, exactly
layer.visible = mask.enabled = false;
```

## Layers

`engine.addLayer(source, origin)` adds a set of splats beside the world's tree. `source` is `{ bytes }` or `{ url }`. A URL is read through the engine's `source`, the same `Fetch` as the world, so the page's tokens or signed URLs apply. It resolves with a `Layer` once the layer is decoded, and rejects when the pack does not load or the layers hold more splats than the device can.

- The input is a pack, as [format.md](format.md) gives it, whose positions count from `origin`, a south-west corner in whole metres. `encodeLayer(splats)` writes one from splats in world coordinates. It is in `@kalyptos/narcissus` and `@kalyptos/narcissus/format`, and runs in the browser and in Node.
- Layer splats go through the same passes as the world's, and one sort orders them all by depth. A layer never shows through the world's splats, or the world through a layer's.
- A layer has no levels of detail. It draws the finest level of its pack at every distance. Off screen its clusters are culled, and far away its sub-pixel splats are dropped before the sort.
- `visible` and `opacity` (0 to 1) change it on the next frame. A hidden layer costs no frame time. Its splats stay on the GPU, at 28 bytes each, until `remove()`, so it shows again at once.
- The splats of visible layers in view count in the budget: the world draws that many fewer.
- Layers stay when the engine opens another world.

## Masks

`engine.addMask(options)` hides, fades or tints splats inside or outside a vertical prism. The options:

- `polygon`: one ring of `[e, n]` corners, or a list of rings. Each ring has three or more corners. The rings count by the even-odd rule, so a ring inside another is a hole and a ring inside a hole is an island. GeoJSON Polygon `coordinates` fit as they are.
- `z`: `[from, to]` in world heights, the full height when left out.
- `targets`: what the mask acts on: `'world'` for the world's own splats, and layers.
- `outside`: when `true`, the mask acts on what lies outside the prism.
- `opacity`: what the splats it covers keep, 0 to 1. The default 0 hides them.
- `tint`: `[r, g, b, a]`, each 0 to 1. A covered splat mixes its colour toward `rgb` by `a`. The default `[0, 0, 0, 0]` keeps the colour.

The rule: a splat of a target is covered while its centre lies inside the polygon and within `z`, or, with `outside`, while it does not. The opacity of a covered splat is multiplied by `opacity`, and the splat takes the tint. Where several masks cover a splat, their opacities multiply and their tints apply in the order the masks were added.

It holds at every level of detail, through the fades between levels, and while pages stream: the test runs on each splat before it is projected, whatever page drew it. Only a mask with opacity 0 drops whole clusters before the GPU sees them: the clusters it covers wholly. Other clusters pay a test for each splat when a mask may cover some of their splats. For a mask with opacity 0 these are only the clusters its edges or its `z` ends cross. A mask that fades or tints tests each splat of every cluster it covers in whole or in part, so it costs the test over its whole area. An `outside` mask is checked against every cluster.

Every field of the `Mask` can be set: `polygon`, `z`, `targets`, `outside`, `opacity`, `tint` and `enabled`. Changes apply at the next frame, and all the changes made between two frames cost one pass over the pages they touch, so a page can hold thousands of small masks. `remove()` ends the mask. After it the setters do nothing and the getters keep their last values. A bad option, in `addMask` or a setter, throws a `RangeError` that names it. A target layer must belong to this engine and must not be removed. `engine.heights()` follows the masks too: a splat counts there with the opacity the masks leave it. `engine.ground()` does not: it reads the coarse ground from the tree's index.

## Picking

`engine.pick(x, y)`, with canvas CSS pixels such as a pointer event's `offsetX` and `offsetY`, resolves with a `Hit`, or `null` where nothing is there, such as the sky:

- `point`: where the pixel's ray meets the hit splat's plane.
- `normal`: the splat's thinnest axis, toward the camera. Splats on a surface lie flat along it, so it is the surface normal there.
- `layer`: the `Layer` hit, or `null` for the world.

The hit is where the splats that the last frame drew over the pixel, blended front to back, first cover half of it, after masks and plugins. Faint splats that blend into a surface therefore give a hit too. A pick renders no frame. It is one small compute pass over the clusters under the pixel, so it is fast enough for every pointer move, and a page can start a pick while others are pending. It answers about a frame later. When more splats lie under the pixel than the pick holds, it holds more and answers on the next frame instead, so it is late but never falsely `null`.

`engine.pickMany(points)` picks many canvas pixels against the same frame and resolves with a `Hit` or `null` for each, in order. One compute pass serves up to 64 pixels, so the pixels a pointer crossed in a frame, or a few around it, cost about as much as one pick. Picks asked for before the next frame are answered together in the same way.

## Lines and markers

`engine.addLine(points, style)` draws a polyline through world points, and `engine.addMarker(point, style)` draws a dot. Both draw over the finished frame, after the plugins. Each returns a handle whose fields set it: `points` (or `point`), `style` and `visible`. `style` reads back with the defaults filled in, so `line.style = { ...line.style, colour }` changes one of them. A hidden graphic is not drawn. Changes apply at the next frame. `remove()` ends a graphic; after it, its setters do nothing. A bad point or style throws a `RangeError`.

- `width` and `size` are CSS pixels. `colour` is RGBA from 0 to 1. `closed` joins a line's last point to its first.
- With `occlude`, the default, a part behind splats is hidden. A line drawn on picked ground points still shows: a part may lie up to 2 % of its distance behind the splats.
- The depth tested against is that of the nearest splat fragment with any opacity, so a faint floater can hide a short piece of a line.

`engine.toScreen(point)` gives the CSS pixel of a world point under the camera set last, for HTML a page puts over the canvas, such as a label or a spinner. Update that HTML in `engine.onFrame(fn)`, which runs after the controls set the camera, so it moves with the frame. A page that draws on the GPU itself does so in a `Post` plugin, which gets the frame's matrices and its depth (see [architecture.md](architecture.md)).

## Capture

`engine.capture({ type, quality })` resolves with the next frame as a `Blob`, as `canvas.toBlob` gives it: PNG by default, or `type: 'image/jpeg'` or `'image/webp'` with a `quality` from 0 to 1. It rejects when the browser cannot encode the image, and when the engine is destroyed or loses its device first.

## Camera and input

The controls, `viewer.controls`, own the map camera. On a page of its own, `new Controls(canvas, engine, { ground, pose, limits })` makes them: `ground(e, n)` gives the height the camera stays above, `pose` is the first pose, and `limits` how far a pose may go, `LIMITS` when left out.

- `pose` gives the pose shown, and `onChange(fn)` calls `fn(pose)` each time it changes.
- `jump(pose)` shows a pose at once. Fields left out keep their value.
- `flyTo(pose, { signal })` animates there. It resolves `true` on arrival, and `false` when the user moves the camera, another `flyTo` or `jump` starts, or the signal aborts.
- `fit(box, pose)` from `@kalyptos/narcissus` gives the pose that shows a box, keeping the heading and tilt of `pose`: `controls.flyTo(fit(layer.box, controls.pose))`.
- `limits` gives the limits, and setting it moves the camera into the new ones at once.
- `enabled = false` makes the camera ignore the user, and flights still run.

The keys (f to fly, then WASD, the arrows, Q and E) act only while the canvas has focus, so text fields and other viewers on the page keep theirs. The controls make the canvas focusable, and a click on it gives it focus. The element gives the canvas its own `aria-label`.

To take a pointer event for itself, so that the camera does not also orbit or pan, a page listens on the element in the capture phase and calls `preventDefault()`. A double click after a taken `pointerdown` does not fly the camera either, so a tool that ends on a double click needs nothing more:

```ts
viewer.addEventListener(
	'pointerdown',
	async (event) => {
		event.preventDefault();
		const hit = await viewer.engine!.pick(event.offsetX, event.offsetY);
		if (hit) corners.push([hit.point[0], hit.point[1]]);
	},
	{ capture: true }
);
```

## Events

- The element sends `start` when it has made the engine and the controls, and `ready`, with the `World` as its detail, each time a world is open. `error` carries a message. `NarcissusViewerEventMap` types them for `addEventListener`.
- The engine and the controls, and the layers, masks, lines, markers, listeners and settings a page adds to them, live from `start` until the element leaves the page. They stay when `src` changes. An element put back on the page makes new ones and sends `start` again.
- `engine.open()` resolves when a world is open.
- `addLayer` resolves when a layer is in and rejects when it fails.
- `engine.onProgress(fn)` calls `fn({ planned, missing, loading })` when the view's loading changes. `missing` of `planned` splats are not loaded yet.
- `engine.onLost(fn)` reports a lost device.

## Cost

Measured with `SOURCE=synthetic LAYERS=4 pnpm bench`, one run each, on an RTX 4060 at 1920×1080, budget 4,000,000. Each pose had four layers of 150,000 splats beside it, each with a world mask over it and a 2 m band.

| metric                     | world alone | with layers |
| -------------------------- | ----------- | ----------- |
| GPU ms per frame           | 3.47        | 4.07        |
| frames per second          | 251         | 222         |
| splats drawn               | 1,799,922   | 2,110,387   |
| splats in the world's plan | 2,066,432   | 1,454,080   |
| pool MiB                   | 357         | 390         |

The world's plan gives up about the 600,000 layer splats in view at each pose. The pool grows by the layers' 1,200,000 splats at 28 bytes each.
