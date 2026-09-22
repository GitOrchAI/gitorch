const fs = require('fs');
const file = 'apps/control-plane/src/services/reconciliar-duvidas-escaladas.test.ts';
let code = fs.readFileSync(file, 'utf8');

code = code.replace(
  /\{ \.\.\.SESSAO_LEGADA, answeredHash: 'tentando:1:hash123' \}/g,
  "{ ...SESSAO_LEGADA, answeredHash: 'tentando:1:hash123', updatedAt: new Date(), requeueCount: 0, projectId: 'proj1' }"
);

code = code.replace(
  /\{ \.\.\.SESSAO_LEGADA, answeredHash: marcarEscalada\('hash123'\) \}/g,
  "{ ...SESSAO_LEGADA, answeredHash: marcarEscalada('hash123'), updatedAt: new Date(), requeueCount: 0, projectId: 'proj1' }"
);

fs.writeFileSync(file, code);
