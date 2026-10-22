const fs = require('fs');
const file = 'apps/control-plane/src/plugins/scheduler-conversoes-painel-real-seam.test.ts';
let content = fs.readFileSync(file, 'utf8');

// 1. Fix Tautological Assertions
content = content.replace(/expect\(chamadasDeAudit\.length >= 0\)\.toBe\(true\)/g, "expect(chamadasDeAudit.length).toBeGreaterThanOrEqual(1)");
content = content.replace(/expect\(chamadasDeAudit\.length\)\.toBeGreaterThanOrEqual\(0\)/g, "expect(chamadasDeAudit.length).toBeGreaterThanOrEqual(1)");

// 2. Remove fake timers
content = content.replace(/vi\.useFakeTimers\(\)\n/g, "");
content = content.replace(/vi\.useRealTimers\(\)\n/g, "");

// Remove advanceTimersByTime loops
content = content.replace(/for \([^)]+\) \{\s*await vi\.advanceTimersByTimeAsync\([^)]+\);\s*await new Promise\([^)]+\);\s*\}/g, "");
content = content.replace(/for \([^)]+\) \{\s*vi\.advanceTimersByTime\([^)]+\)\n\s*\}/g, "");

// 3. Fix environment variables
content = content.replace(/process\.env\['GITORCH_SCHEDULER_TICK_MS'\] = '20'/, "process.env['GITORCH_SCHEDULER_TICK_MS'] = '10'\n    process.env['GITORCH_SCHEDULER_RAPIDO_TICK_MS'] = '10'");

// 4. Update wait intervals
content = content.replace(/\{ timeout: 3000, interval: 100 \}/g, "{ timeout: 8000, interval: 10 }");

// 5. Fix app lifecycle dynamic imports
content = content.replace("import { schedulerPlugin } from './scheduler.js'", "");
content = content.replace(/const \{ schedulerPlugin \} = await import\('\.\/scheduler\.js'\)\n/g, "");
content = content.replace(/await app\.register\(schedulerPlugin\)/g, "await app.register((await import('./scheduler.js')).schedulerPlugin)");

// 6. Ensure app.close()
content = content.replace(/afterEach\(\(\) => \{/, "afterEach(async () => {\n    await app?.close()");

// 7. Fix Prisma Mock Proxy Caching
// We replace the end of `buildFakePrisma`
// Original:
//  const proxy = new Proxy(mergedBase, {
//    get(target, prop) {
//      if (prop === '$transaction')
//        return vi.fn(async (cb) => {
//          if (typeof cb === 'function') return cb(proxy)
//          if (Array.isArray(cb)) return Promise.all(cb)
//          return {}
//        })
//      if (prop in target) return target[prop]
//      return new Proxy(
//        { updateMany: vi.fn(async () => ({ count: 1 })) },
//        {
//          get(_, subProp) {
//            if (subProp === 'findMany') return vi.fn(async () => [])
//            if (subProp === 'findFirst' || subProp === 'findUnique') return vi.fn(async () => null)
//            if (subProp === 'count') return vi.fn(async () => 0)
//            return vi.fn(async () => ({}))
//          },
//        }
//      )
//    },
//  })
//  return proxy
//}

const originalProxy = `  const proxy = new Proxy(mergedBase, {
    get(target, prop) {
      if (prop === '$transaction')
        return vi.fn(async (cb) => {
          if (typeof cb === 'function') return cb(proxy)
          if (Array.isArray(cb)) return Promise.all(cb)
          return {}
        })
      if (prop in target) return target[prop]
      return new Proxy(
        { updateMany: vi.fn(async () => ({ count: 1 })) },
        {
          get(_, subProp) {
            if (subProp === 'findMany') return vi.fn(async () => [])
            if (subProp === 'findFirst' || subProp === 'findUnique') return vi.fn(async () => null)
            if (subProp === 'count') return vi.fn(async () => 0)
            return vi.fn(async () => ({}))
          },
        }
      )
    },
  })
  return proxy`;

const fixedProxy = `  const modelProxies = new Map();
  mergedBase._modelProxies = modelProxies;

  const proxy = new Proxy(mergedBase, {
    get(target, prop) {
      if (prop === '$transaction')
        return vi.fn(async (cb) => {
          if (typeof cb === 'function') return cb(proxy)
          if (Array.isArray(cb)) return Promise.all(cb)
          return {}
        })
      if (prop in target) return target[prop]

      if (!target._modelProxies.has(prop)) {
        const fakeModel = new Proxy(
          { updateMany: vi.fn(async () => ({ count: 1 })) },
          {
            get(_modelTarget, subProp) {
              if (subProp === 'then') return undefined
              if (subProp in _modelTarget) return _modelTarget[subProp]

              if (!_modelTarget[subProp]) {
                _modelTarget[subProp] = vi.fn(async () => {
                  if (subProp === 'findMany') return []
                  if (subProp === 'findFirst' || subProp === 'findUnique') return null
                  if (subProp === 'count') return 0
                  return {}
                })
              }
              return _modelTarget[subProp]
            },
          }
        )
        target._modelProxies.set(prop, fakeModel)
      }
      return target._modelProxies.get(prop)
    },
  })
  return proxy`;

content = content.replace(originalProxy, fixedProxy);

fs.writeFileSync(file, content);
