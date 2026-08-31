const fs = require('fs');

const file = 'apps/control-plane/src/services/telegram-bot.ts';
let content = fs.readFileSync(file, 'utf8');

// The reviewer said "The explicit instructions to accept the main branch comment (Conflict 1) and to use the specific text string (Conflict 2) were ignored."
// The first instruction: "Aceite integralmente o bloco `>>>>>>> origin/main`." which has a comment explaining the escape hatch behavior.
// The second instruction: "Use a versão do `origin/main`" for the text string.
// Let's replace the string I added with the exact string requested.

content = content.replace(
  "text: '✍️ Por favor, digite e envie sua resposta para a dúvida do PO:\\n\\n\"' + question.text + '\"',",
  "text: 'Responda por texto: envie sua resposta como uma mensagem normal aqui no chat e o agente retoma de onde parou.',"
);

// I need to add the comment that was originally in origin/main back to the top of the `FREE_TEXT_OPTION_VALUE` block.
const commentBlock = `
    // O escape hatch de digitação livre foi invocado. Não tentamos processar a
    // resposta via parse de opção aqui, porque a resposta virá numa MENSAGEM de
    // texto que este callback só destrava. Mostra uma instrução via alert.
`;

content = content.replace(
  "  if (option.value === FREE_TEXT_OPTION_VALUE) {",
  commentBlock + "  if (option.value === FREE_TEXT_OPTION_VALUE) {"
);

fs.writeFileSync(file, content);
