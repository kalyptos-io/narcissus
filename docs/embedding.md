# Embedding the viewer

From its `start` event, `<narcissus-viewer>` gives these hooks through its `engine` and `controls` properties; [examples/hooks.html](../examples/hooks.html) uses each. Positions are world coordinates as `world.json` declares them, as float64.

To replace part of the world:

```ts
import { encodeLayer } from '@kalyptos/narcissus';

const { pack, origin } = await encodeLayer(splats); // or a pack from a server, and its origin
const layer = await engine.addLayer({ bytes: pack, origin });
const mask = engine.addMask({ polygon, targets: ['world'] });

// show the original again, exactly
layer.visible = mask.enabled = false;
```

## Handles

`addLayer`, `addMask`, `addLine` and `addMarker` give a handle with settable fields. Changes show at the next frame; all changes between two frames cost one update. After `remove()`, setters do nothing and getters keep their last values.

Points, corners, headings, widths and sizes must be finite, and opacities and colour channels from 0 to 1. A bad input throws a `RangeError` that names the field; `addLayer` rejects with it.

## Layers

`engine.addLayer(options)` resolves with a `Layer`. It rejects when the pack does not load, the layers need more splats than the device holds, or the engine is destroyed.

| option           | value                                                                                               | default              |
| ---------------- | --------------------------------------------------------------------------------------------------- | -------------------- |
| `url` or `bytes` | a pack as [format.md](format.md) gives it, or its URL                                               | required             |
| `origin`         | `[e, n]`, the pack's south-west corner in whole metres                                              | required             |
| `position`       | `[e, n, h]`, where the anchor goes                                                                  | where it was encoded |
| `heading`        | degrees clockwise seen from above                                                                   | 0                    |
| `visible`        | whether the layer draws                                                                             | `true`               |
| `opacity`        | of every splat                                                                                      | 1                    |
| `pickable`       | `false`: `pick()` passes through; the layer still draws, obeys masks and adds to `engine.heights()` | `true`               |
| `signal`         | aborts the read; `addLayer` then rejects with `signal.reason`                                       |                      |

`encodeLayer(splats)`, in `@kalyptos/narcissus` and `@kalyptos/narcissus/format`, writes a pack and its `origin` from world-coordinate splats, in the browser or Node. A `url` is read through the engine's `source`. The anchor is the centre of the encoded box, at the height of its lowest splat centre; a splat encoded at `p` shows at `position + R(heading)(p - anchor)`.

A `Layer` gives `splats`, its splat count, and `box`, its world extent where it stands now. You can set `position`, `heading`, `visible`, `opacity` and `pickable`. A layer sorts with the world by depth and draws at full detail at every distance. A hidden layer costs no frame time, but keeps its splats on the GPU, at 28 bytes each, until `remove()`. Visible layers in view count in the world's budget. Layers stay through `open()`.

## Masks

`engine.addMask(options)` hides, fades or tints splats inside or outside a vertical prism.

| option    | value                                                                | default                                   |
| --------- | -------------------------------------------------------------------- | ----------------------------------------- |
| `polygon` | one ring of three or more `[e, n]` corners, or a list of rings       | required                                  |
| `z`       | `[from, to]` in world heights, `from` at most `to`                   | the full height                           |
| `targets` | `'world'` and layers of this engine that are not removed             | required                                  |
| `outside` | `true` acts outside the prism                                        | `false`                                   |
| `opacity` | what covered splats keep of their opacity                            | 1 with a `tint`; else 0, which hides them |
| `tint`    | `[r, g, b, a]`: a covered splat mixes its colour toward `rgb` by `a` | `[0, 0, 0, 0]`                            |

Rings count by the even-odd rule, so GeoJSON Polygon `coordinates` fit as they are. A splat of a target is covered while its centre is inside the prism, or outside it with `outside`. Where masks overlap, opacities multiply and tints apply in the order of the masks. A hiding mask is cheap; a fading or tinting mask, and any `outside` mask, tests every splat it touches.

You can set every option, and `enabled`. `engine.heights()` obeys masks; `engine.ground()` does not.

## Picking

`engine.pick(x, y)` takes canvas CSS pixels. It resolves with `null` over nothing, else with a `Hit` on the surface that the last frame drew there, after masks: its world `point`, the surface `normal` toward the camera, and the `layer` hit, `null` for the world.

A pick renders no frame. It answers about one frame later, or a frame later still when the pixel holds many splats. You can pick at each pointer move. `engine.pickMany(points)` resolves with a `Hit` or `null` for each pixel, in order, at about the cost of one pick for up to 64 pixels.

To drag a layer over the area its own mask hides, disable that mask during the drag.

## Lines and markers

`engine.addLine(points, style)` draws a polyline through one or more world points, and `engine.addMarker(point, style)` a dot. Their handles have `points` or `point`, `style` and `visible`.

| `style` field | value                                  | default        |
| ------------- | -------------------------------------- | -------------- |
| `colour`      | `[r, g, b, a]`                         | `[1, 1, 1, 1]` |
| `width`       | of a line, CSS pixels, more than 0     | 2              |
| `size`        | of a marker, CSS pixels, more than 0   | 12             |
| `closed`      | joins a line's last point to its first | `false`        |
| `occlude`     | hides the parts behind splats          | `true`         |

`style` reads back with the defaults filled in, so `line.style = { ...line.style, colour }` changes one field.

`engine.toScreen(point)` gives the canvas CSS pixel of a world point, or `null` behind the camera. Place HTML over the canvas in `engine.onFrame(fn)`, which runs after the controls set the camera. To draw on the GPU, write a `Post` plugin ([architecture.md](architecture.md)).

## Capture

`engine.capture({ type, quality })` resolves with the next frame as a `Blob`, as `canvas.toBlob` gives it: PNG by default, or `'image/jpeg'` or `'image/webp'` with a `quality` from 0 to 1. It rejects when the browser cannot encode it, or the engine is destroyed or loses its device first.

## Camera and input

`viewer.controls` owns the map camera. Without the element, use `new Controls(canvas, engine, { ground, pose, limits })`: `ground(e, n)` gives the height to stay above, `pose` the first pose, and `limits` defaults to `LIMITS`, `{ pitch: [-90, -20], dist: [1, 2485], clearance: 10, floor: 50 }`.

To move the camera without the controls, call `engine.setCamera(camera)` with a `Camera`, `{ e, n, h, yaw, pitch, fov }`, angles in degrees. Add `{ jump: true }` when the camera did not travel there, so the engine does not load ahead along a false motion.

A `Pose` is `{ e, n, h, yaw, pitch, dist }`: the focus, `yaw` clockwise from north and `pitch` (negative down) in degrees, and `dist` from camera to focus in metres.

| member                    | what it does                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `pose`                    | gives the pose shown                                                                                    |
| `onChange(fn)`            | calls `fn(pose)` each time the pose changes                                                             |
| `jump(pose)`              | shows a pose at once; fields left out keep their value                                                  |
| `flyTo(pose, { signal })` | animates there; `true` on arrival, `false` when input, another move, the signal or `destroy()` stops it |
| `moveTo(e, n)`            | moves the focus to the ground there; a view farther than 300 m closes in                                |
| `limits`                  | setting it moves the camera into the new limits at once                                                 |
| `enabled`                 | `false` ignores the user; flights still run                                                             |
| `destroy()`               | stops a flight and removes the listeners                                                                |

`fit(box, pose)` gives the pose that shows a box, with the heading and tilt of `pose`: `controls.flyTo(fit(layer.box, controls.pose))`.

Keys (F to fly, then WASD, arrows, Q and E) act only while the canvas has focus; a click gives it focus.

To take a pointer event from the camera, and the double click after it, call `preventDefault()` in a capture-phase listener on the element:

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

## Events and lifetime

- The element sends `start` once the engine and the controls exist, `ready` with the `World` each time a world opens, and `error` with a message. `NarcissusViewerEventMap` types them.
- The engine, the controls and all you add to them live from `start` until the element leaves the web page, through changes of `src`. Put back, the element makes new ones and sends `start` again.
- `engine.onProgress(fn)` calls `fn({ planned, missing, loading })` when one of them changes: `missing` of the `planned` splats in view are not loaded yet.
- `engine.onLost(fn)` calls `fn(reason)` when the device is lost; the engine then stops.
- The `on` methods return a function that removes the listener.

## Cost

Measured with `SOURCE=synthetic LAYERS=4 pnpm bench`, one run each, on an RTX 4060 at 1920×1080, budget 4,000,000. Each pose had four layers of 150,000 splats beside it, each with a world mask over it and a 2 m band.

| metric                     | world alone | with layers |
| -------------------------- | ----------- | ----------- |
| GPU ms per frame           | 3.30        | 3.98        |
| frames per second          | 260         | 236         |
| splats drawn               | 1,799,922   | 2,110,387   |
| splats in the world's plan | 2,066,432   | 1,454,080   |
| pool MiB                   | 357         | 390         |

`engine.stats()` gives numbers like these, for diagnosis; its fields can change in any release.
