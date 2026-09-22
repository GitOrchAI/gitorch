const fs = require('fs');
const file = 'apps/control-plane/src/services/reconciliar-duvidas-escaladas.test.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /\{ \.\.\.SESSAO_LEGADA, updatedAt: new Date\(Date\.now\(\) - 1000\) \}/g,
  "{ ...SESSAO_LEGADA, updatedAt: new Date(Date.now() - 1000), requeueCount: 0, projectId: 'proj1' }"
);

fs.writeFileSync(file, code);
