const fs = require('fs');
const file = 'apps/control-plane/src/services/reconciliar-duvidas-escaladas.test.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /findMany: vi\.fn\(async \(\) => \[\{ \.\.\.SESSAO_LEGADA, answeredHash: 'tentando:1:hash123' \}\]\),/g,
  "findMany: vi.fn(async () => [{ ...SESSAO_LEGADA, answeredHash: 'tentando:1:hash123', updatedAt: new Date(), requeueCount: 0, projectId: 'proj1' }]),"
);

code = code.replace(
  /findMany: vi\.fn\(async \(\) => \[\n *\{ \.\.\.SESSAO_LEGADA, answeredHash: marcarEscalada\('hash123'\) \},\n *\]\),/g,
  "findMany: vi.fn(async () => [\n          { ...SESSAO_LEGADA, answeredHash: marcarEscalada('hash123'), updatedAt: new Date(), requeueCount: 0, projectId: 'proj1' },\n        ]),"
);

fs.writeFileSync(file, code);
