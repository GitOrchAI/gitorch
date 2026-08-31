const fs = require('fs');

const file = 'apps/control-plane/src/services/telegram-bot.ts';
let content = fs.readFileSync(file, 'utf8');

// The reviewer EXACTLY said:
// text: 'Responda por texto: envie sua resposta como uma mensagem normal aqui no chat e o agente retoma de onde parou.',

content = content.replace(
  "      text:\n        '✍️ Por favor, digite e envie sua resposta para a dúvida do PO:\\n\\n\"' + question.text + '\"',",
  "      text: 'Responda por texto: envie sua resposta como uma mensagem normal aqui no chat e o agente retoma de onde parou.',"
);

fs.writeFileSync(file, content);
