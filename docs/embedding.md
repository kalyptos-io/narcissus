# Embedding the viewer

A page that embeds narcissus can add its own splats, hide parts of the world, find what is under the cursor, draw lines and markers in the scene, and steer the camera. These hooks know nothing of the page. They are on the engine and the controls, which `<narcissus-viewer>` gives as its `engine` and `controls` properties after its `ready` event.

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

`engine.addMask({ polygon, z, targets })` hides splats. `polygon` is three or more `[e, n]` corners. `z` is `[from, to]` in world heights, the full height when left out. `targets` lists what the mask hides: `'world'` for the world's own splats, and layers.

The rule: a splat of a target is hidden while its centre lies inside the polygon by the even-odd rule and within `z`.

It holds at every level of detail, through the fades between levels, and while pages stream: the test runs on each splat before it is projected, whatever page drew it. Clusters that a mask covers wholly are left out before the GPU sees them. Only splats in clusters that an edge of a mask crosses are tested one by one. `enabled` turns a mask off and on, and `remove()` ends it. `engine.heights()` follows the masks too. `engine.ground()` does not: it reads the coarse ground from the tree's index.

## Picking

`engine.pick(x, y)`, with canvas CSS pixels such as a pointer event's `offsetX` and `offsetY`, resolves with a `Hit` or `null` over the sky:

- `point`: where the pixel's ray reaches the hit splat's depth.
- `normal`: the splat's thinnest axis, toward the camera. Splats on a surface lie flat along it, so it is the surface normal there.
- `layer`: the `Layer` hit, or `null` for the world.

The hit is the nearest splat that draws the pixel at 0.5 opacity or more, after masks and plugins, as the last frame showed it. A pick renders no frame. It is one small compute pass over the clusters under the pixel, so it is fast enough for every pointer move. It answers about a frame later, so a page should not start a new pick while one is pending.

## Lines and markers

`engine.addLine(points, style)` draws a polyline through world points, and `engine.addMarker(point, style)` draws a dot. Both draw over the finished frame, after the plugins. `set()` moves them and `remove()` ends them.

- `width` and `size` are CSS pixels. `colour` is RGBA from 0 to 1. `closed` joins a line's last point to its first.
- With `occlude`, the default, a part behind splats is hidden. A line drawn on picked ground points still shows: a part may lie up to 2 % of its distance behind the splats.
- The depth tested against is that of the nearest splat fragment with any opacity, so a faint floater can hide a short piece of a line.

`engine.toScreen(point)` gives the CSS pixel of a world point under the camera set last, for HTML a page puts over the canvas, such as a label or a spinner. A page that draws on the GPU itself does so in a `Post` plugin, which gets the frame's matrices and its depth (see [architecture.md](architecture.md)).

## Camera and input

The controls, `viewer.controls`, own the map camera:

- `pose` gives the pose shown, and `onChange(fn)` calls `fn(pose)` each time it changes.
- `jump(pose)` shows a pose at once. Fields left out keep their value.
- `flyTo(pose, { signal })` animates there. It resolves `true` on arrival, and `false` when the user moves the camera, another `flyTo` or `jump` starts, or the signal aborts.
- `fit(box, pose)` from `@kalyptos/narcissus` gives the pose that shows a box, keeping the heading and tilt of `pose`: `controls.flyTo(fit(layer.box, controls.pose))`.
- `enabled = false` makes the camera ignore the user, and flights still run.

To take a pointer event for itself, so that the camera does not also orbit or pan, a page listens on the element in the capture phase and calls `preventDefault()`:

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

Controls are made again when the element opens another world. Take `viewer.controls` again after each `ready` event.

## Events

- `engine.open()` resolves, and the element sends `ready`, when a world is open.
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
