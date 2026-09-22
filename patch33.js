const fs = require('fs');
const file = 'apps/control-plane/src/services/reconciliar-duvidas-escaladas.test.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /\{ sessionName: 'sessions\/legada', issueNumber: 46, answeredHash: 'tentando:1:hash123' \}/g,
  "{ sessionName: 'sessions/legada', issueNumber: 46, answeredHash: 'tentando:1:hash123', updatedAt: new Date(), requeueCount: 0, projectId: 'proj1' }"
);

code = code.replace(
  /\{ \.\.\.SESSAO_LEGADA, answeredHash: 'tentando:1:hash123' \}/g,
  "{ ...SESSAO_LEGADA, answeredHash: 'tentando:1:hash123', updatedAt: new Date(), requeueCount: 0, projectId: 'proj1' }"
);

fs.writeFileSync(file, code);
