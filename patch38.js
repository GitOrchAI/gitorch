const fs = require('fs');
const file = 'apps/control-plane/src/services/reconciliar-duvidas-escaladas.test.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /\{ sessionName: 'sessions\/legada', issueNumber: 46, answeredHash: 'tentando:1:hash123', updatedAt: new Date\(\), requeueCount: 0, projectId: 'proj1' \}/g,
  "{ sessionName: 'sessions/legada', issueNumber: 46, answeredHash: 'tentando:1:hash123', updatedAt: new Date(), requeueCount: 0, projectId: 'proj1' }"
);

// We need to replace ALL instances in findMany mocks
code = code.replace(
  /findMany: vi\.fn\(async \(\) => \[\n *\{ sessionName: 'sessao-1', issueNumber: 123, answeredHash: 'respondida:0:abc', updatedAt: AGORA_MAIS_ANTIGO, requeueCount: 0, projectId: 'p1' \},\n *\{ sessionName: 'sessao-2', issueNumber: 456, answeredHash: 'respondida:0:def', updatedAt: AGORA_MAIS_ANTIGO, requeueCount: 0, projectId: 'proj1' \}\n *\]\)/,
  "findMany: vi.fn(async () => [{ sessionName: 'sessao-1', issueNumber: 123, answeredHash: 'respondida:0:abc', updatedAt: AGORA_MAIS_ANTIGO, requeueCount: 0, projectId: 'p1' }, { sessionName: 'sessao-2', issueNumber: 456, answeredHash: 'respondida:0:def', updatedAt: AGORA_MAIS_ANTIGO, requeueCount: 0, projectId: 'proj1' }])"
);

fs.writeFileSync(file, code);
