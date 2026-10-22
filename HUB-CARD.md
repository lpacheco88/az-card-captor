# hub-card.js — card do backend ↔ Azure DevOps

Um card por vez, chamado pelo agente a partir da pasta do `v2-hub`. O `.env` é lido da pasta do azure-worker; o PAT
nunca aparece na saída.

| Momento | Comando | Estado no Azure |
| --- | --- | --- |
| Escolher a feature (pai) | `node <azure-worker>/hub-card.js features` | — |
| Listar o épico inteiro (somente leitura) | `... tree [--epic <id>] [--out <md>]` | — |
| Card novo, sem número no Azure | `... create --card "Claude outputs/card-X.md" --parent <feature>` (ou `--like <task code irmão>`) | Não iniciado |
| Card que já existe no Azure | `... link <id> --card "Claude outputs/card-X.md"` | — |
| Começou a implementar | `... start --card "Claude outputs/card-X.md" --branch <branch>` | Codificação |
| PR aberto | `... review --card ... --pr <link> [--no-notify]` | Code review |
| PR mergeado | `... done --card ... [--hours <N>] [--resumo <md>]` | Concluído |
| Fechar os cards já mergeados | `... sync [--dry-run]` | Concluído nos mergeados |
| Ajustar horas (estimativa) | `... rehours <id> [--hours N] [--dry-run]` | Sem mudar o estado |
| Card no board errado | `... reparent <id> (--like <task code> | --parent <id>) --confirm` | Move o pai e a área/iteração |
| Mover um card para a sprint atual | `... retarget <id> --confirm [--dry-run]` | Sprint atual do time (sem mudar estado/pai) |
| Comunicar front/PM/QA | `... notify <id> --to front,pm,qa --md <arquivo> [--pr <link>] [--dry-run]` | — |
| Resolver pessoas | `... people resolve [--write]` | — |
| Responder "entrou na main" | `... reply <id> [--note "<texto>"] [--dry-run]` | — |
| `describe <id> --md <arquivo>` | Acrescenta ou substitui a seção "🤖 Situação do backend" no fim da Descrição, sem apagar o texto do PM | — |

- **`tree [--epic <id>] [--out <md>]`** (somente leitura): usa WIQL recursivo e `GET wit/workitems` para listar o épico
  (`TARGET_EPIC_ID`, padrão 105346) e todos os descendentes. Imprime (ou grava em `--out`) uma tabela por feature/PBI
  com id, Task Code, título, tipo, estado, sprint (`IterationPath`), responsável, `OriginalEstimate`, `CompletedWork`,
  tags e data da última alteração (`ChangedDate`). Não cria, edita, move nem comenta nada.

- `create`/`link` gravam `azure: <id>` no cabeçalho do card e a linha em `Claude outputs/plano-cards.md` (colunas: Card, Azure, Título, Branch, Status, PR, **Horas**, Atualizado; o `done`/`rehours` grava as horas na coluna Horas).
- `start`/`review`/`done` mudam o estado, juntam a tag `Hub-Agente`, escrevem no histórico e atualizam o plano.
- `--dry-run` mostra o que faria sem chamar o Azure. `--preview prev.html` (no `create`) gera a prévia do HTML.
- Card `Concluído` ou `Cancelado` não é alterado sem `--force`.
- Não use mais o `update_worker.js` no fluxo: ele regrava a descrição de **todos** os cards a cada execução.
- O `create` e o `reparent` só aceitam um pai que esteja sob o épico `TARGET_EPIC_ID` (o `get` mostra a cadeia até o épico). Prefira `--like <Task Code irmão>`: copia o **pai** e a **área** dele (o que garante o mesmo board).
- A **iteração** (sprint) do `create`/`reparent`/`retarget` é sempre a **sprint atual do time** (`GET .../teamsettings/iterations?$timeframe=current`), time em **`HUB_CARD_TEAM`** (padrão no código: `Industria`) — **nunca** a do irmão. `--iteration <path>` sobrescreve.
- **Responsável**: todo card do fluxo é atribuído ao **usuário autenticado do PAT** (hoje `luciano.pacheco@nstech.com.br`, lido de `connectionData`). `create`, `link`, `start`, `review`, `done` (inclusive pelo `sync`) e `rehours` leem `System.AssignedTo` e, se não for esse usuário, atribuem — na **mesma** chamada do comando, sem histórico extra. **`--assign`** → **`HUB_CARD_ASSIGNEE`** (variável de ambiente, fora do `.env`) ainda sobrescrevem; o `AssignedTo` do irmão (`--like`) **não** é mais usado. Nunca toca card fora do fluxo.
- `retarget <id> [--dry-run]` move um card **já criado** para a sprint atual do time, **sem** mudar estado nem pai (só `System.IterationPath` + histórico).
- **Mudar a sprint de um card existente só com `--confirm` e por ordem do Luciano.** `retarget` e `reparent` sem `--confirm` apenas mostram o que fariam e saem com aviso. **Nenhum outro comando** (`rehours`, `done`, `sync`, `link`, `start`, `review`, `describe`) grava `System.IterationPath`; só o `create` define a sprint do card **novo** (sprint atual do time).
## Comunicação com front, PM e QA

Pessoas em **`hub-card.people.json`** (`front`, `pm`, `qa`). `people resolve [--write]` busca as identidades (pelo e-mail; sem e-mail, pelo nome), mostra nome/e-mail/id e **só grava o `id` com `--write` após confirmação**.

- **`notify <id> --to front,pm,qa --md <arquivo> [--pr <link>] [--dry-run]`**: publica o conteúdo do `.md` (HTML simples) no card, marcando as pessoas dos públicos escolhidos. `--dry-run` mostra o HTML e quem seria marcado, sem publicar.
- **Menção**: `<a href="#" data-vss-mention="version:2.0,{id}">@Nome</a>` (dispara a notificação).
- **`review --card ... --pr <link>`**: lê a seção do card cujo título contém **"Fora do código"** e publica **um comentário por público** com os itens `Front:`, `PM:`, `QA:` (com ou sem negrito):

  ```
  ## 6. Fora do código (descrição do PR)

  - **Front:**
    - ...
  - **PM:**
    - ...
  - **QA:**
    - ...
  ```

  Sem a seção (ou sem itens), não publica nada e avisa. Use **`--no-notify`** no `review` para fazer só a transição para **Code review** sem publicar comentários.
- **`done`** (inclusive pelo `sync`): se o card já tiver **comentário publicado pelo hub-card** (`notify` ou `review`), responde **uma vez** com `<card> entrou na main (commit <hash>)` marcando as mesmas pessoas. Sem comentário anterior, não publica.
- **`reply <id> [--note "<texto>"] [--dry-run]`**: publica a resposta de "entrou na main" **sob demanda**, com a linha extra opcional do `--note`. Só funciona se o card já tiver comentário publicado pelo hub-card; senão, avisa e não publica.
- **Sem duplicar**: estado em `hub-card.notify-state.json` (hash do conteúdo + público). Mesmo conteúdo não republica; conteúdo novo vira **"Atualização:"**. Nunca menciona pessoa fora do `people.json`; não edita nem apaga comentários; o comentário sai com a identidade do PAT; nenhum outro campo do card muda.

## Horas do card = estimativa de dev sênior (front matter `estimativa:`)

Sem cálculo pelo git. O valor vem do campo **`estimativa:`** no cabeçalho do card `.md`.

- **`create`/`link`** gravam `estimativa` em `Microsoft.VSTS.Scheduling.OriginalEstimate`. Card sem `estimativa:`: o `create` **recusa**; o `link` **avisa e segue**.
- **`done`** (inclusive o chamado pelo `sync`): `CompletedWork` = `OriginalEstimate` do work item (se vazio, usa a `estimativa` do card, achando o arquivo pelo `azure: <id>` em `Claude outputs`) e `RemainingWork = 0`; grava o mesmo valor na coluna Horas do plano. Sem estimativa em nenhum dos dois: o `done` recusa; o `sync` **pula o card, avisa e segue**. `--hours <N>` sobrescreve.
- **`rehours <id> [--hours N] [--dry-run]`**: grava `OriginalEstimate = CompletedWork = N` (ou a `estimativa`/`OriginalEstimate` existente) e `RemainingWork = 0`, além da coluna Horas do plano — **sem** mudar estado e **sem** histórico. Sem `--hours`/estimativa, erro. `--original-only` grava **só** o `OriginalEstimate`.
- Histórico do Azure no `done`: só **"🤖 Agente: card concluído."** (com o link do PR, se houver).
- `sync [--dry-run]` roda **dentro do repositório atual** (o `v2-hub`) e só **lê** o git (`git fetch origin`; sem checkout, commit ou push). Para cada linha do `plano-cards.md` em **Codificação**/**Code review** com branch, considera **mergeada** se a branch for ancestral da `origin/main` **ou** se houver na `origin/main` um commit cujo assunto cite a branch ou o código do card entre parênteses (ex.: `(QA-02)` — cobre squash e branch apagada). Mergeada → `done` com a estimativa (`OriginalEstimate`/`estimativa`), gravando a coluna Horas do plano; sem estimativa, **pula o card, avisa e segue**; senão, nada. Imprime uma linha por card (mergeado/aberto + horas); `--dry-run` só lista o que faria e um erro em um card não para os outros. Uma branch **sem trabalho próprio** — mesmo commit da criação (reflog "branch: Created from ...") ou nenhum commit desde a criação — **não** conta como mergeada, mesmo sendo ancestral da `origin/main`. Sem reflog, a ancestralidade só vale se houver na `origin/main` um commit citando o **código do card** (ex.: `(QA-04)`).
