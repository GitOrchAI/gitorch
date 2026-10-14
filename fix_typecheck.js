const fs = require('fs');

function fixTypes(file) {
  let content = fs.readFileSync(file, 'utf8');
  content = content.replace(/\(cb as any\)/g, "(cb as Function)");
  content = content.replace(/\(args as any\)/g, "(args as { where?: any })");
  content = content.replace(/\(c as any\)/g, "(c as { data?: any })");
  content = content.replace(/let app: any/g, "let app: Fastify.FastifyInstance");
  content = content.replace(/import fetch from 'node-fetch'/g, "import fetch from 'node-fetch'\n// @ts-expect-error missing type\ntype RequestInit = any");
  content = content.replace(/if \(app\) await app.close\(\)/g, "if (app) await (app as unknown as { close: () => Promise<void> }).close()");
  content = content.replace(/cb: unknown/g, "cb: any");
  content = content.replace(/args: unknown/g, "args: any");

  fs.writeFileSync(file, content);
}

const files = [
  'apps/control-plane/src/plugins/scheduler-status-analise-falhas-real-seam.test.ts',
  'apps/control-plane/src/plugins/scheduler-status-encanamento-gitorch-real-seam.test.ts',
  'apps/control-plane/src/plugins/scheduler-status-entrega-voltou-fila-real-seam.test.ts',
  'apps/control-plane/src/plugins/scheduler-status-incidente-infra-desistiu-real-seam.test.ts',
  'apps/control-plane/src/plugins/scheduler-esteira-parada-vaga-real-seam.test.ts',
  'apps/control-plane/src/plugins/scheduler-pos-merge-real-seam.test.ts'
];

files.forEach(fixTypes);
