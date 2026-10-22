const fs = require('fs');
const file = 'apps/control-plane/src/plugins/scheduler-conversoes-painel-real-seam.test.ts';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/get\(_modelTarget: unknown, modelProp: string\) \{/g, 'get(_modelTarget: Record<string, unknown>, modelProp: string) {');
content = content.replace(/cb: unknown/g, 'cb: (val: unknown) => unknown');

fs.writeFileSync(file, content);
