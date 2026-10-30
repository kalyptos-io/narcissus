# Architecture

narcissus is one package. Its source is in layers, and each layer is a directory under `src/`.

| layer       | holds                                                    | may import                     | runs in               |
| ----------- | -------------------------------------------------------- | ------------------------------ | --------------------- |
| `format/`   | the codec of Guldmund Trees: parse and decode, no I/O    | nothing                        | browser, worker, Node |
| `ports.ts`  | `Fetch`, `Cache`, `Missing`: the contracts for bytes     | nothing                        | browser, worker, Node |
| `adapters/` | `http`, `files`, `disk`, `memory`, `opfs`                | ports                          | each where it can     |
| `tools/`    | `walk`, `validate`, `info`, `exportPly` over any `Fetch` | format, ports                  | browser, Node         |
| `engine/`   | the WebGPU engine                                        | format, ports, adapters        | browser               |
| `controls/` | the map camera and the pose math                         | engine                         | browser               |
| `element/`  | `<narcissus-viewer>`                                     | engine, controls               | browser               |
| `cli/`      | the `narcissus` command                                  | format, ports, adapters, tools | Node                  |

Two rules keep the layers apart, and `pnpm lint` enforces both:

- A layer imports another layer only through that layer's `index.ts`. So the `index.ts` files are the public API, and a change behind them breaks no other layer.
- `format/`, `tools/` and `ports.ts` use no `window`, `document` or `navigator`, so they run in Node.

The table in `eslint.config.js` is the source of these rules. A test may also import the ports and the adapters.

## Ports

A port is a contract that has more than one implementation.

**`Fetch`** gives the bytes of a URL, whole or a range. It is the only way the engine and the tools read a world. To read from somewhere new, write a function:

```ts
import { createEngine, http, type Fetch } from '@kalyptos/narcissus';

const signed: Fetch = (url, range, signal) => http(`${url}?${token}`, range, signal);
const engine = await createEngine(canvas, { settings, sky, source: signed });
```

A `Fetch` rejects with `Missing` when the file is not there. The engine then reads `world.json` again, because a missing unit file means the world was replaced.

The built-in `http` source runs inside the engine's workers. A `Fetch` from the page cannot move to a worker, so it runs on the main thread and the workers ask it by message (`engine/stream/remote.ts`).

**`Cache`** keeps bytes the engine has read. It runs inside the workers, so the choice is closed for now: `'opfs'`, `'memory'` or `'none'`.

**`Plugin`** changes what the engine draws. A plugin gets a `Host` and installs a `Shade`, a WGSL function that runs for each splat, or a `Post`, a full-screen pass after the splats. `engine/plugins/fog.ts` is the shortest example of the first and `grade.ts` of the second. `engine.use(plugin)` installs one and returns the function that removes it.

A page that embeds the viewer has more hooks: layers, masks, picking, lines and markers, and the camera. [embedding.md](embedding.md) describes them.

## The engine

`engine/engine.ts` is the composition root: it makes the device, the loader, the tree and the renderer, and runs the frame loop. The rest has one job each:

| directory  | job                                                                           |
| ---------- | ----------------------------------------------------------------------------- |
| `world/`   | the tree of units that are known, and the pages they hold                     |
| `plan/`    | which pages to draw for a camera and a budget; pure functions                 |
| `math/`    | matrices and the frustum                                                      |
| `stream/`  | which pages to load next, and the workers that fetch and decode them          |
| `gpu/`     | the page pool on the GPU and the passes: cull, project, sort, raster, present |
| `plugins/` | fog, depth of field and the colour grade                                      |

`plan/`, `world/`, `math/` and most of `stream/` do not touch the GPU or the network, and their tests run in Node. The tests of the GPU passes run the real WGSL on a GPU adapter through the `webgpu` package.

## Build

`pnpm build` writes `dist/`, which mirrors `src/`: Vite bundles the five entry points and `tsc` writes the declarations. The stream worker is inlined into the bundle as a blob, so the package needs no bundler setting and works from a CDN. `pnpm package` checks the packed package with publint and attw.

## Benchmarks

`pnpm bench` and `pnpm bench:drive` measure the engine in a real Chrome. They are a workstation tool: they need Linux, Chrome at `/opt/google/chrome/google-chrome`, a GPU and the `cage` compositor, and they are not part of CI.

The quick bench accepts `CPU_RATE=6` for sixfold CPU throttling. This leaves GPU speed unchanged. Set `FRAME_LIMIT_MS=1000` to allow slow frames that exceed the default 100 ms validity limit. Results record both settings. A saved baseline is compared only when the adapter, world and benchmark settings match. `SNAPSHOT=/tmp/view.png` saves the settled second pose, and `PROFILE=/tmp/moves.cpuprofile` saves a CPU profile of the camera moves.
