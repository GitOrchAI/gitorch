The E2E test `tests/e2e/setup-wizard-funil-completo-fake.spec.ts` failed in the CI workflow `e2e-funil-fake` because the file `apps/control-plane/node_modules/@gitorch/cadence/dist/index.js` could not be found.

Wait, during the CI log, I see:
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/home/runner/work/gitorch/gitorch/apps/control-plane/node_modules/@gitorch/cadence/dist/index.js' imported from /home/runner/work/gitorch/gitorch/apps/control-plane/src/lib/spend-guard.ts
```

Why is it trying to resolve `@gitorch/cadence` from `apps/control-plane/node_modules/@gitorch/cadence/dist/index.js` instead of `packages/cadence/dist/index.js` or via the monorepo root `node_modules`?
Ah! Because pnpm uses symlinks! `apps/control-plane/node_modules/@gitorch/cadence` is a symlink to `packages/cadence`.
And in the e2e test, we run: `pnpm exec tsx scripts/ci/e2e-playwright.ts`.
Wait, if it's a symlink, why is `dist/index.js` missing?
Because `packages/cadence` hasn't been built yet in that particular CI step, OR the build output was not cached/restored?
Let's check the CI workflow for `e2e-funil-fake` again.
