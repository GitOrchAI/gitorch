# Como o seu projeto avisa que a versão subiu

Este documento é para quem publica **fora do GitHub** — numa VM própria, num
servidor de casa, num serviço que não registra nada de volta. Se a sua
publicação acontece por GitHub Actions com `environment:`, ou por um serviço
que cria deployments no GitHub, você não precisa de nada disto: o GitOrch já
enxerga sozinho.

## Por que isto existe

O GitOrch só sabia confirmar publicação **olhando o GitHub**. Numa VM privada
não há o que olhar: o GitHub nunca fica sabendo que a versão subiu. O
resultado, medido num projeto real, foi o pior possível — quase mil leituras
recusadas em 24 horas e seis entregas já mescladas paradas, cada uma esperando
uma confirmação que nunca ia chegar.

A regra não mudou: o GitOrch **não diz "está no ar" sem prova**. O que mudou é
de onde a prova pode vir. Agora quem publica pode avisar.

## Os cinco caminhos

O GitOrch pergunta uma vez, no Telegram, como o seu projeto chega ao ar. A sua
resposta fica guardada e ele não pergunta de novo. Cada resposta muda o que ele
faz quando uma entrega é mesclada:

| Sua resposta | O que o GitOrch faz |
|---|---|
| **Workflow do GitHub Actions** | Acompanha a execução do workflow, como sempre. Se não houver workflow de publicação ativo, ele diz isso e encerra a entrega no merge. |
| **Serviço externo** (Render, Vercel…) | Se o serviço registra a publicação no GitHub, ele lê de lá. Se não registra, espera o seu aviso. |
| **Servidor meu (VM própria)** | Não fica lendo o que não existe. Espera o aviso do seu CD — é o caso deste documento. |
| **Publico na mão** | A entrega termina no merge, dito com todas as letras. Quem sobe ao ar é você. |

Em todos eles existe um teto: se o aviso não chegar, o GitOrch encerra a
entrega dizendo exatamente isso — nunca fingindo que ainda vai descobrir, e
nunca deixando a tarefa aberta para sempre.

## Avisando, na prática

Ao fim do seu deploy, uma chamada:

```bash
curl -X POST "$GITORCH_URL/api/projects/$PROJECT_ID/publicado" \
  -H "Authorization: Bearer $GITORCH_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"commit\": \"$(git rev-parse HEAD)\", \"url\": \"https://seu-site\"}"
```

- `commit` (**obrigatório**): o SHA **inteiro** do que subiu. O GitOrch compara
  com a entrega que está esperando confirmação e **recusa** se não bater —
  carimbar a versão errada seria pior que não carimbar nada.
- `sucesso`: mande `false` quando o deploy falhou. O GitOrch registra a falha;
  ele nunca vai dizer que está no ar por conta própria.
- `url`: onde ficou no ar, se você souber dizer. Só informativo.
- `GITORCH_API_KEY`: a chave do projeto, a mesma que o assistente de
  configuração entregou. Ela vale só para **este** projeto.

### As respostas

| Resposta | O que aconteceu |
|---|---|
| `{"registrado": true, "estado": "no-ar"}` | Confirmado. A tarefa fecha. |
| `{"registrado": true, "estado": "falhou"}` | Registrado como falha de publicação. |
| `{"registrado": false, "motivo": "..."}` | Nada a fazer — em geral um reenvio, ou não há entrega esperando. **Não é erro**: repetir a chamada é seguro. |
| `409` | O commit avisado não é o da entrega que está esperando. |

Chamar duas vezes não faz mal: o reenvio é reconhecido e devolve `200`, para
que um CD que repete em caso de erro não entre em rajada.
