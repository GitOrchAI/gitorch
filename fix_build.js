const fs = require('fs');
const file = 'apps/control-plane/src/plugins/scheduler-conversoes-painel-real-seam.test.ts';
let content = fs.readFileSync(file, 'utf8');

// Element implicitly has an 'any' type because expression of type 'string | symbol' can't be used to index type
content = content.replace(/if \(subProp in _modelTarget\) return _modelTarget\[subProp\]/g,
  "if (subProp in _modelTarget) return (_modelTarget as any)[subProp]"
);

content = content.replace(/if \(!_modelTarget\[subProp\]\)/g,
  "if (!(_modelTarget as any)[subProp])"
);

content = content.replace(/_modelTarget\[subProp\] = vi\.fn\(/g,
  "(_modelTarget as any)[subProp] = vi.fn("
);

content = content.replace(/return _modelTarget\[subProp\]/g,
  "return (_modelTarget as any)[subProp]"
);

fs.writeFileSync(file, content);
