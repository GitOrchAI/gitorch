const fs = require('fs');

if (fs.existsSync('/app/debug_audits.log')) {
  console.log("File exists, content:");
  console.log(fs.readFileSync('/app/debug_audits.log', 'utf8').split('\n').slice(-5));
} else {
  console.log("/app/debug_audits.log NOT CREATED!");
}
