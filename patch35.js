const fs = require('fs');
const file = 'apps/control-plane/src/services/reconciliar-duvidas-escaladas.test.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /sessionName: 'sessao-2', issueNumber: 456, answeredHash: 'respondida:0:def', updatedAt: AGORA_MAIS_ANTIGO/g,
  "sessionName: 'sessao-2', issueNumber: 456, answeredHash: 'respondida:0:def', updatedAt: AGORA_MAIS_ANTIGO, requeueCount: 0, projectId: 'proj1'"
);

code = code.replace(
  /sessionName: 'sessao-nova', issueNumber: 789, answeredHash: 'respondida:0:ghi', updatedAt: AGORA_RETA_FINAL/g,
  "sessionName: 'sessao-nova', issueNumber: 789, answeredHash: 'respondida:0:ghi', updatedAt: AGORA_RETA_FINAL, requeueCount: 0, projectId: 'p1'"
);

code = code.replace(
  /sessionName: 'sessao-escalada', issueNumber: 101, answeredHash: 'escalada:0:xyz', updatedAt: AGORA_MAIS_ANTIGO/g,
  "sessionName: 'sessao-escalada', issueNumber: 101, answeredHash: 'escalada:0:xyz', updatedAt: AGORA_MAIS_ANTIGO, requeueCount: 0, projectId: 'p1'"
);

code = code.replace(
  /\{ sessionName: 'sessions\/legada', issueNumber: 46, answeredHash: 'tentando:1:hash123' \}/g,
  "{ sessionName: 'sessions/legada', issueNumber: 46, answeredHash: 'tentando:1:hash123', updatedAt: new Date(), requeueCount: 0, projectId: 'proj1' }"
);

code = code.replace(
  /\{ sessionName: 'sessions\/legada', issueNumber: 46, answeredHash: marcarEscalada\('hash123'\) \}/g,
  "{ sessionName: 'sessions/legada', issueNumber: 46, answeredHash: marcarEscalada('hash123'), updatedAt: new Date(), requeueCount: 0, projectId: 'proj1' }"
);

fs.writeFileSync(file, code);
