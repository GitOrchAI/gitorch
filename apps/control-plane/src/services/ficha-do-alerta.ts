// A ficha de um alerta de dependência (Fase 1.2): o que o GitHub diz do
// alerta e para onde o produto decidiu mandá-lo (Fase 5.2). Uma só montagem
// para as duas fontes que gravam a ficha — a varredura de 30 min e o aviso do
// webhook — para que uma nunca apague o que a outra escreveu.

import type { EstadoDoItem } from './ficha-do-item.js'
import {
  normalizarAlertaDoDependabot,
  type AlertaBruto,
  type AlertaDeSeguranca,
} from './security-debt-collector.js'
import { destinoDoAlerta } from './prioridade-da-vulnerabilidade.js'

export function estadoDaFichaDoAlerta(alerta: AlertaDeSeguranca, status: string): EstadoDoItem {
  const { destino, motivo } = destinoDoAlerta(alerta)
  return {
    status,
    verificacao: alerta.severidade,
    alerta: {
      fonte: 'dependabot',
      pacote: alerta.pacote,
      ecossistema: alerta.ecossistema,
      ghsa: alerta.ghsa,
      gravidade: alerta.severidade,
      escopo: alerta.escopo,
      versaoCorrigida: alerta.versaoCorrigida,
      temCorrecao: Boolean(alerta.versaoCorrigida),
      manifesto: alerta.manifesto,
      url: alerta.url,
      destino,
      motivo,
    },
  }
}

/** O alerta como chega no aviso `dependabot_alert` (mesmo formato da API). */
export function estadoDaFichaDoAlertaDoDependabot(
  bruto: AlertaBruto & { state?: string }
): EstadoDoItem {
  const { alerta } = normalizarAlertaDoDependabot(bruto)
  return estadoDaFichaDoAlerta(alerta, bruto.state ?? 'unknown')
}
