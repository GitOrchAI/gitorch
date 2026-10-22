const fs = require('fs');

// We have wasted too much time trying to manually proxy the PRISMA MOCK correctly.
// Let's use `vitest` `vi.spyOn` or simply return a static mock that doesn't proxy EVERYTHING dynamically.
// Or just let `buildFakePrisma` dynamically build ONLY the models required!
// Actually, `buildFakePrisma` doesn't NEED a proxy for all missing models if the test only touches a few!
// BUT if the fastify plugin relies on random models to boot (e.g. `missionConsumption`, `pendency`), then it needs them.

// Let's just use the exact proxy from earlier that WORKED except for "Entrega mesclada".
// Wait, my previous proxy WORKED perfectly for the first 5 tests!
// Let's restore the one that worked!

const proxyCode = `  const modelProxies = new Map();
  mergedBase._modelProxies = modelProxies;

  return new Proxy(mergedBase, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof typeof target]
      if (prop === 'then') return undefined
      if (prop === '$transaction') return async (cb: any) => cb(target)

      if (!target._modelProxies.has(prop)) {
        const fakeModel = new Proxy({}, {
          get(_modelTarget: any, modelProp: string) {
            if (modelProp === 'then') return undefined

            if (!_modelTarget[modelProp]) {
              _modelTarget[modelProp] = vi.fn(async () => {
                if (modelProp === 'findFirst' || modelProp === 'findUnique') return null
                if (modelProp === 'findMany') return []
                if (modelProp === 'count') return 0
                return {}
              })
            }
            return _modelTarget[modelProp]
          }
        })
        target._modelProxies.set(prop, fakeModel)
      }
      return target._modelProxies.get(prop)
    }
  })`;

const file = 'apps/control-plane/src/plugins/scheduler-conversoes-painel-real-seam.test.ts';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/  const modelProxies = new Map\(\);\n  mergedBase\._modelProxies = modelProxies;\n\n  const proxy = new Proxy\(mergedBase, \{[\s\S]*?\}\)\n  return proxy/, proxyCode);

// Fix mesclada text logic:
// Original query in "Entrega mesclada": args.where?.closedReason === 'merged' OR state === 'merged'
content = content.replace(/if \(args\.where\?\.status === 'merged' \|\| args\.where\?\.state === 'merged' \|\| JSON\.stringify\(args\)\.includes\('mergeCommitSha'\)\) \{/g,
  "if (JSON.stringify(args).includes('mergeCommitSha')) {"
);

fs.writeFileSync(file, content);
