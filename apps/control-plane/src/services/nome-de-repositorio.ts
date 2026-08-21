/**
 * A guarda da PORTA para o endereço de um repositório do GitHub.
 *
 * Existe porque o produto monta URLs colando este texto direto na rota da API
 * (`https://api.github.com/repos/${repo}/...`) — e essas chamadas levam
 * credencial junto. Quem controla o texto controla, sem isto, qual endpoint
 * recebe o token: a normalização de URL resolve `..` ANTES de a requisição
 * sair (`/repos/../user/repos?` vira exatamente `/user/repos`), e `?`/`#`
 * cortam o resto do caminho que o código achava que estava fixo.
 *
 * A lição já paga por este produto num alerta crítico de request-forgery é
 * que a checagem mora NA PORTA de saída de rede, com comparação EXATA de
 * formato — nunca por prefixo, nunca só nos chamadores, que se multiplicam.
 *
 * O formato exato é o do GitHub: um dono e um repositório separados por UMA
 * barra, e nada mais.
 */

/**
 * Login de conta ou organização: letras, números e hífen, sem hífen na ponta,
 * até 39 caracteres (o teto do próprio GitHub). Ponto de propósito FORA — um
 * dono não tem ponto, e sem ponto não existe `..` deste lado.
 */
const DONO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

/**
 * Nome de repositório: letras, números, ponto, hífen e underscore, até 100
 * caracteres. O ponto é legítimo aqui (`minha-lib.js`), então `.` e `..`
 * sozinhos precisam ser recusados à parte — são eles que viram travessia.
 */
const REPOSITORIO = /^[A-Za-z0-9._-]{1,100}$/

/**
 * `true` só para o formato exato "dono/repositorio".
 *
 * Recusa travessia (`a/b/../../..`), barra a mais, segmento vazio, espaço,
 * esquema de URL, arroba, codificação percentual, quebra de linha e qualquer
 * comprimento acima do que o GitHub aceita. Não confirma que o repositório
 * EXISTE nem a quem pertence — só que o texto não consegue trocar o endereço
 * que o produto vai chamar.
 */
export function nomeDeRepositorioValido(valor: string): boolean {
  if (typeof valor !== 'string') return false

  const partes = valor.split('/')
  if (partes.length !== 2) return false

  const [dono, repositorio] = partes as [string, string]
  if (!DONO.test(dono)) return false
  if (!REPOSITORIO.test(repositorio)) return false
  // Só de pontos não é nome de repositório — é caminho relativo disfarçado.
  if (repositorio === '.' || repositorio === '..') return false

  return true
}
