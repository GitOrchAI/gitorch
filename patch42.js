const fs = require('fs');
const file = 'apps/control-plane/src/services/reconciliar-duvidas-escaladas.test.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /\{ sessionName: 'sessions\/legada-2', issueNumber: 47, answeredHash: marcarRespondida\('hash456'\), updatedAt: new Date\(Date\.now\(\) - 26 \* 60 \* 60 \* 1000\) \}/g,
  "{ sessionName: 'sessions/legada-2', issueNumber: 47, answeredHash: marcarRespondida('hash456'), updatedAt: new Date(Date.now() - 26 * 60 * 60 * 1000), requeueCount: 0, projectId: 'proj1' }"
);

fs.writeFileSync(file, code);
