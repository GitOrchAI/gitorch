const fs = require('fs');
const file = 'apps/control-plane/src/plugins/scheduler-conversoes-painel-real-seam.test.ts';
let content = fs.readFileSync(file, 'utf8');

content = content.replace(/cb: any/g, 'cb: unknown');

fs.writeFileSync(file, content);
