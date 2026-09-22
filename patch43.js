const fs = require('fs');
const file = 'apps/control-plane/src/services/reconciliar-duvidas-escaladas.test.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /updatedAt: new Date\(Date\.now\(\) - 25 \* 60 \* 60 \* 1000\), \/\/ older than HORAS_ATE_TIMEOUT_PERGUNTA_MS \(24h\)/g,
  "updatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),\n            requeueCount: 0,\n            projectId: 'proj1',\n            // older than HORAS_ATE_TIMEOUT_PERGUNTA_MS (24h)"
);

fs.writeFileSync(file, code);
