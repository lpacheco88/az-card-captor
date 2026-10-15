# hub-card.js — card do backend ↔ Azure DevOps

Um card por vez, chamado pelo agente a partir da pasta do `v2-hub`. O `.env` é lido da pasta do azure-worker; o PAT
nunca aparece na saída.

| Momento | Comando | Estado no Azure |
| --- | --- | --- |
| Escolher a feature (pai) | `node <azure-worker>/hub-card.js features` | — |
| Card novo, sem número no Azure | `... create --card "Claude outputs/card-X.md" --parent <feature>` (ou `--like <task code irmão>`) | Não iniciado |
| Card que já existe no Azure | `... link <id> --card "Claude outputs/card-X.md"` | — |
| Começou a implementar | `... start --card "Claude outputs/card-X.md" --branch <branch>` | Codificação |
| PR aberto | `... review --card ... --pr <link>` | Code review |
| PR mergeado | `... done --card ... [--hours <N>] [--resumo <md>]` | Concluído |
| Fechar os cards já mergeados | `... sync [--dry-run]` | Concluído nos mergeados |
| Recalcular horas (regra nova) | `... rehours <id> [--dry-run]` | Sem mudar o estado |
| Card no board errado | `... reparent <id> --like <task code do board certo>` | Move o pai e a área/iteração |
| `describe <id> --md <arquivo>` | Acrescenta ou substitui a seção "🤖 Situação do backend" no fim da Descrição, sem apagar o texto do PM | — |

- `create`/`link` gravam `azure: <id>` no cabeçalho do card e a linha em `Claude outputs/plano-cards.md` (colunas: Card, Azure, Título, Branch, Status, PR, **Horas**, Atualizado; o `done`/`rehours` grava as horas na coluna Horas).
- `start`/`review`/`done` mudam o estado, juntam a tag `Hub-Agente`, escrevem no histórico e atualizam o plano.
- `--dry-run` mostra o que faria sem chamar o Azure. `--preview prev.html` (no `create`) gera a prévia do HTML.
- Card `Concluído` ou `Cancelado` não é alterado sem `--force`.
- Não use mais o `update_worker.js` no fluxo: ele regrava a descrição de **todos** os cards a cada execução.
- O `create` e o `reparent` só aceitam um pai que esteja sob o épico `TARGET_EPIC_ID` (o `get` mostra a cadeia até o épico). Prefira `--like <Task Code irmão>`: copia o pai, a área e a iteração dele, o que garante o mesmo board.
- `done` **sem `--hours`** estima as horas pela **janela** 08:00–18:00 em America/Sao_Paulo em **todos os dias** (inclusive sábado e domingo). **Início** = o menor entre: entrada em **Codificação** (Azure), criação da branch (reflog local) e o **1º commit** da branch após o merge-base com a `origin/main` (ou o merge-base, se já mergeada). **Fim** = o maior entre a entrada em **Code review** (Azure) e o **último commit** da branch; se o fim ficar antes do início, usa só os dados do git. Horas do card = **janela × fator**, fator padrão **0,5** (troque por `HUB_CARD_HOURS_FACTOR`; não vai no `.env`), arredondado para 0,5 (mínimo 0,5). Histórico: "Xh estimadas (janela de Yh × 0,5; início: <reflog|Codificação|commit>, fim: <Code review|commit>)". Sem data de início, recusa e pede `--hours`. O `--hours` informado tem prioridade e **não** recebe o fator.
- `rehours <id> [--dry-run]` recalcula as horas com a regra atual e regrava **só** o `CompletedWork`, o histórico e a coluna Horas do plano, **sem mexer no estado**; funciona em card `Concluído` sem `--force`. `done` e `rehours` **leem o git do repositório atual** — rode-os **a partir do `v2-hub`**; fora de um repositório git, avisa e usa só as datas do Azure.
- `sync [--dry-run]` roda **dentro do repositório atual** (o `v2-hub`) e só **lê** o git (`git fetch origin`; sem checkout, commit ou push). Para cada linha do `plano-cards.md` em **Codificação**/**Code review** com branch, considera **mergeada** se a branch for ancestral da `origin/main` **ou** se houver na `origin/main` um commit cujo assunto cite a branch ou o código do card entre parênteses (ex.: `(QA-02)` — cobre squash e branch apagada). Mergeada → `done` com as horas estimadas (grava a coluna Horas do plano); senão, nada. Imprime uma linha por card (mergeado/aberto + horas); `--dry-run` só lista o que faria e um erro em um card não para os outros. Uma branch no **mesmo ponto da `origin/main`** (recém-criada, sem commits próprios) **não** conta como mergeada.
