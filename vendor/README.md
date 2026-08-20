# Vendored packages

Third-party source pinned into this repository. Vendoring means: we keep a **frozen copy**
of the upstream source so our build never depends on upstream changes (the upstream API is
explicitly unstable during its release-candidate phase).

## @cubus/cordis

- **Upstream**: <https://github.com/cordiverse/cordis> (packages/core)
- **Upstream version**: 4.0.0-rc.8
- **Upstream commit**: `8cc9e33fab69e2d0476d126baaf2acb24e6a6ab4`
- **Vendored on**: 2026-08-19
- **Local modifications** (re-applied mechanically on every sync):
  1. Package renamed `cordis` -> `@cubus/cordis` (private: true).
  2. All relative imports get an explicit `.ts` suffix, and `declare module './x'`
     targets get a `.js` suffix — required because our consumers compile under
     `moduleResolution: NodeNext` (upstream uses `bundler`). Scripted rewrite:
     `from './x' -> from './x.ts'`; `from '.' -> from './index.ts'`;
     `declare module './x' -> declare module './x.js'`.
  3. `tsconfig.json` mirrors the upstream compiler settings (bundler resolution,
     `noImplicitAny/noImplicitThis/strictFunctionTypes: false`, `erasableSyntaxOnly: false`).
  4. `tsconfig.build.json` emits declarations only (`lib/index.d.ts`); consumers read
     types from the declarations so vendored source is never checked under our strict
     consumer settings. Runtime still resolves `src/index.ts` (vitest/vite transforms it).
  5. Lint does not cover `vendor/` (upstream code style is upstream's concern).
- **Sync procedure**: replace `vendor/cordis/src` with the upstream tree at a pinned
  commit, update the version/commit fields above, re-apply the scripted import rewrites
  (item 2), then run `pnpm run typecheck && pnpm run test`.
