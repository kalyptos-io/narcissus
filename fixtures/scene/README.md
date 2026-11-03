# Example scene

The world the examples in `examples/` open: one unit of 2,500 blocks on a rolling field, 62.5 m square, written by narcissus's own writers from `src/format/scene.test.ts`. It shares no data with guldmund.

`world.json` declares two streams, both from each splat's centre:

- `example.confidence`, f16: a scanner's confidence, falling with the distance from where it stood.
- `example.object`, u32: the block's object id, spread over 0 to 2^20.

`NARCISSUS_FIXTURES=write pnpm exec vitest --run src/format/scene.test.ts` writes it afresh.
