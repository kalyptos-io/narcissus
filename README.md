# narcissus

The open library for Guldmund Trees: gaussian-splat scenes of any size, stored as static files and
streamed by range request. narcissus holds the format, a WebGPU engine that draws it, and tools to
check a tree.

This is early work. The package is not on npm yet.

## Develop

```bash
pnpm install
pnpm check && pnpm lint && pnpm test
```

The tests of the GPU kernels need a GPU adapter.

## Licence

[BSD-3-Clause](LICENSE).
