const fs = require('fs');
const file = 'apps/control-plane/src/plugins/scheduler-conversoes-painel-real-seam.test.ts';
let content = fs.readFileSync(file, 'utf8');

const originalProxy = `  const modelProxies = new Map();
  mergedBase._modelProxies = modelProxies;

  const proxy = new Proxy(mergedBase, {
    get(target, prop) {
      if (prop === '$transaction')
        return vi.fn(async (cb) => {
          if (typeof cb === 'function') return cb(proxy)
          if (Array.isArray(cb)) return Promise.all(cb)
          return {}
        })
      if (prop in target) {
        if (!target._modelProxies.has(prop)) {
           // We also need to proxy the ALREADY DEFINED objects so they get stable vi.fns for undefined methods
           const fakeModel = new Proxy(target[prop as string], {
            get(_modelTarget, subProp) {
              if (subProp === 'then') return undefined
              if (subProp in _modelTarget) return (_modelTarget as any)[subProp]

              if (!(_modelTarget as any)[subProp]) {
                (_modelTarget as any)[subProp] = vi.fn(async () => {
                  if (subProp === 'findMany') return []
                  if (subProp === 'findFirst' || subProp === 'findUnique') return null
                  if (subProp === 'count') return 0
                  return {}
                })
              }
              return (_modelTarget as any)[subProp]
            }
           });
           target._modelProxies.set(prop, fakeModel);
        }
        return target._modelProxies.get(prop);
      }

      if (!target._modelProxies.has(prop)) {
        const fakeModel = new Proxy(
          { updateMany: vi.fn(async () => ({ count: 1 })) },
          {
            get(_modelTarget, subProp) {
              if (subProp === 'then') return undefined
              if (subProp in _modelTarget) return (_modelTarget as any)[subProp]

              if (!(_modelTarget as any)[subProp]) {
                (_modelTarget as any)[subProp] = vi.fn(async () => {
                  if (subProp === 'findMany') return []
                  if (subProp === 'findFirst' || subProp === 'findUnique') return null
                  if (subProp === 'count') return 0
                  return {}
                })
              }
              return (_modelTarget as any)[subProp]
            },
          }
        )
        target._modelProxies.set(prop, fakeModel)
      }
      return target._modelProxies.get(prop)
    },
  })
  return proxy`;

// Now instead of the complex proxy that is mutating objects under the hood, let's just use `vi.fn` caching per method globally in the outer get!
// Actually, `Prop in target` was failing probably because target had `{}` and `prop` was `'devSession'` so it returned `{}` without proxying it?
// Wait, `target['devSession']` is defined in tests! `target['devSession'] = { findMany: ... }`
// The tests passed exactly BEFORE I added the proxy cache for defined objects!
// BUT the tests failed with AssertionError (0 instead of 1) because the FASTIFY plugin didn't tick?
// No, the tests were failing with `AssertionError` for 0 because the scheduler tick query for OTHER models returned `undefined` instead of `[]` because there was NO fallback!
// Let me just revert the proxy to a simple `get(target, prop)` that uses a Map of simple vi.fns!

const simpleProxy = `  const mockCache = new Map();
  return new Proxy(mergedBase, {
    get(target, prop) {
      if (prop === '$transaction')
        return vi.fn(async (cb) => {
          if (typeof cb === 'function') return cb(proxy)
          if (Array.isArray(cb)) return Promise.all(cb)
          return {}
        })

      const modelObj = target[prop] || {};

      if (!mockCache.has(prop)) {
        mockCache.set(prop, new Proxy(modelObj, {
          get(mTarget, mProp) {
            if (mProp === 'then') return undefined;
            if (mProp in mTarget) return mTarget[mProp];
            if (!mockCache.has(prop + '.' + String(mProp))) {
               mockCache.set(prop + '.' + String(mProp), vi.fn(async () => {
                 if (mProp === 'findMany') return [];
                 if (mProp === 'findFirst' || mProp === 'findUnique') return null;
                 if (mProp === 'count') return 0;
                 return {};
               }));
            }
            return mockCache.get(prop + '.' + String(mProp));
          }
        }));
      }
      return mockCache.get(prop);
    }
  });`;

content = content.replace(originalProxy, simpleProxy);

fs.writeFileSync(file, content);
