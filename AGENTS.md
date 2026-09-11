# Repository guidance

## Effect adoption

This branch is gradually adopting [Effect](https://effect.website). Follow the
existing Effect patterns and the [adoption plan](docs/plans/effect-v4-adoption.md)
when working in affected areas. Use the Effect v4 APIs supported by the version
pinned in `package.json`.

Keep adoption incremental and scoped to the task. Preserve observable behavior,
public API boundaries, persistence contracts, and process-lifetime guarantees.
