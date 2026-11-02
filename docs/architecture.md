# Architecture

Each layer of the package is a directory under `src/`.

| layer       | holds                                                    | may import                     | runs in               |
| ----------- | -------------------------------------------------------- | ------------------------------ | --------------------- |
| `format/`   | the Guldmund Tree codec, no I/O                          | nothing                        | browser, worker, Node |
| `ports.ts`  | `Fetch`, `Cache`, `Missing`                              | nothing                        | browser, worker, Node |
| `adapters/` | `http`, `files`, `disk`, `memory`, `opfs`                | ports                          | each where it can     |
| `tools/`    | `walk`, `validate`, `info`, `exportPly` over any `Fetch` | format, ports                  | browser, Node         |
| `engine/`   | the WebGPU engine                                        | format, ports, adapters        | browser               |
| `controls/` | the map camera and pose math                             | engine                         | browser               |
| `element/`  | `<narcissus-viewer>`                                     | engine, controls               | browser               |
| `cli/`      | the `narcissus` command                                  | format, ports, adapters, tools | Node                  |

`pnpm lint` enforces these rules from `eslint.config.js`:

- Other layers import `engine/`, `controls/` and `tools/` only through their `index.ts`, and `format/` only through `index.ts` or `encode.ts`. These files are the public API.
- `format/`, `tools/` and `ports.ts` use no `window`, `document` or `navigator`.
- Tests can also import the ports and the adapters.

## Ports

The engine and the tools read a world only through a `Fetch`. It gives the bytes of a URL, whole or a range, and rejects with `Missing` when the file is not there. To read from elsewhere, write one:

```ts
import { createEngine, http, type Fetch } from '@kalyptos/narcissus';

const signed: Fetch = (url, range, signal) => http(`${url}?${token}`, range, signal);
const engine = await createEngine(canvas, { settings, sky, source: signed });
```

The built-in `http` runs in the engine's workers; a `Fetch` from the web page runs on the main thread.

`Cache` runs in the workers; the `cache` option is `'opfs'` (default), `'memory'` or `'none'`.

A `Plugin` gets a `Host` and installs a `Shade`, a WGSL function for each splat, or a `Post`, a full-screen pass after the splats. `engine/plugins/fog.ts` is the shortest `Shade`, and `grade.ts` the shortest `Post`. `engine.use(plugin)` installs one and returns its remover.

## The engine

In `engine/`, `engine.ts` runs the frame loop, `world/` holds the unit tree, `plan/` picks pages, `stream/` loads them, `gpu/` holds the pool and passes, and `plugins/` the plugins. `layer.ts`, `mask.ts` and `overlay.ts` hold the handles of [embedding.md](embedding.md).

Tests of `plan/`, `world/`, `math/` and most of `stream/` run in Node; GPU pass tests run real WGSL through the `webgpu` package.

## Build

`pnpm build` writes `dist/`, which mirrors `src/`: Vite bundles the five entry points, with the stream worker inline, and `tsc` writes the declarations. `pnpm package` checks the package with publint and attw.

## Benchmarks

`pnpm bench` and `pnpm bench:drive` measure the engine in Chrome. They need Linux, Chrome at `/opt/google/chrome/google-chrome`, a GPU and the `cage` compositor, and are not in CI.

`pnpm bench` takes `CPU_RATE=6` (a sixfold slower CPU), `FRAME_LIMIT_MS=1000` (frame limit, default 100 ms), `SNAPSHOT=/tmp/view.png` (the settled second pose) and `PROFILE=/tmp/moves.cpuprofile` (a CPU profile of the camera moves). Results record `CPU_RATE` and `FRAME_LIMIT_MS`, and are compared with a saved baseline only when the adapter, world and settings match.
