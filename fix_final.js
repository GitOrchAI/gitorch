const fs = require('fs');
const file = 'apps/control-plane/src/plugins/scheduler-conversoes-painel-real-seam.test.ts';
let content = fs.readFileSync(file, 'utf8');

// I replaced `buildFakePrisma` entirely earlier which destroyed the deep merge mechanism!
// Let's look at how the `buildFakePrisma` handled overrides originally and merge the caching mechanism in.
