const fs = require('fs');

// As the user stated:
// "Ensure your mock returns at least one pending record matching the query criteria of the task being tested."
// The issue is that the proxy overrides EVERYTHING, including `count: vi.fn(async () => 0)`.
// But look at the `mergedBase` in `buildFakePrisma`! It ALREADY contains the mocks that the test provided!
// For example:
// `devSession: { findMany: vi.fn(async (args) => { ... }) }`
// So why doesn't my proxy use the overridden `findMany`?!
// Because my proxy's `get(target, prop)` says:
// `if (prop in target) return target[prop]`
// But `target[prop]` returns the overridden `{ findMany: vi.fn(...) }` object directly!!!
// It DOES return the test's `devSession`!
// BUT the test's `devSession` DOES NOT have `findFirst`, `updateMany`, etc., so if the scheduler tries to call `prisma.devSession.findFirst()`, IT CRASHES because it's undefined!
// That's why the scheduler is silently crashing inside `tick()` without emitting any audits!

const file = 'apps/control-plane/src/plugins/scheduler-conversoes-painel-real-seam.test.ts';
let content = fs.readFileSync(file, 'utf8');

// The original proxy was:
// return new Proxy({ updateMany: ... }, { get(_, subProp) { ... } })
// This meant the `findMany` provided by the test WAS IGNORED ENTIRELY if the model wasn't perfectly mocked with all methods?
// No! The original proxy only kicked in if `prop in target` WAS FALSE!
// Wait! `if (prop in target) return target[prop]`
// That means the object provided by the test (`{ findMany: ... }`) was returned directly!
// But because it didn't have `updateMany` or `findFirst`, the scheduler crashed if it called them!
// So I need to wrap `target[prop]` in a proxy that returns fallback functions for missing methods!

content = content.replace(/if \(prop in target\) return target\[prop\]/g,
  "if (prop in target) {\n        if (!target._modelProxies.has(prop)) {\n          const fakeModel = new Proxy(target[prop as string], {\n            get(_modelTarget: any, subProp: string) {\n              if (subProp === 'then') return undefined\n              if (subProp in _modelTarget) return _modelTarget[subProp]\n\n              if (!_modelTarget[subProp]) {\n                _modelTarget[subProp] = vi.fn(async () => {\n                  if (subProp === 'findMany') return []\n                  if (subProp === 'findFirst' || subProp === 'findUnique') return null\n                  if (subProp === 'count') return 0\n                  return {}\n                })\n              }\n              return _modelTarget[subProp]\n            }\n          })\n          target._modelProxies.set(prop, fakeModel)\n        }\n        return target._modelProxies.get(prop)\n      }"
);

fs.writeFileSync(file, content);
