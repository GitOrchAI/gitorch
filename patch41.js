const fs = require('fs');
const file = 'apps/control-plane/src/services/reconciliar-duvidas-escaladas.test.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /findMany: vi\.fn\(async \(\) => \[\n *SESSAO_LEGADA,/g,
  "findMany: vi.fn(async () => [\n          SESSAO_LEGADA,"
);

fs.writeFileSync(file, code);
