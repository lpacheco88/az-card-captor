// apply_agent_updates.js
// Aplica Status/Horas Trabalhadas/Descrição/Notas do Agente nos cards .md do AZ Card Captor.
// Preserva o nome original dos arquivos e o encoding UTF-8.
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "generated_task_codes");

// id -> { done, hours, summary, notes }
const DATA = {
  "107176": {
    done: true,
    hours: 48,
    summary:
      "CRUD de Cliente (fatia customer) com autocomplete por CNPJ (dados globais), " +
      "bloqueio de CNPJ duplicado/inválido, criptografia da senha de portal, auditoria " +
      "atômica e busca por documento sem máscara. Divergência registrada: requires_invoice " +
      "NÃO é forçado por 'Com nota fiscal' (prevalece o UC-004 do PRD).",
  },
  "107247": {
    done: true,
    hours: 32,
    summary:
      "CRUD de Centro de Distribuição com code único por tenant (409/RFC 9457), validação " +
      "de CNPJ (DV, rejeita dígitos repetidos), exigência de ≥1 dia de operação, " +
      "activate/deactivate, isolamento por tenant e cobertura 100%.",
  },
  "107277": {
    done: true,
    hours: 12,
    summary:
      "CRUD de Produto (código, descrição, ean) com criação automática durante a ingestão " +
      "de cargas (find-or-create por evento), isolamento por tenant e auditoria.",
  },
  "107281": {
    done: true,
    hours: 100,
    summary:
      "Importação de Cargas via API (payload) e planilha CSV/XLSX com parser/validador linha " +
      "a linha (linha+coluna), upsert por external_code, validação de CD/Cliente, criação " +
      "automática de produto, agrupamento Carga→Destino→Pedido→Item, 1 agendamento por CNPJ " +
      "de destino e relatórios de importação. Modelo adaptado: sem as tabelas " +
      "load_destinations/orders/items/invoices (usa load + tabelas de schedule + import_run).",
  },
  "107282": {
    done: true,
    hours: 140,
    summary:
      "Motor de transição de status (matriz por status), status inicial por tipo de " +
      "agendamento, recusa de transições inválidas/regressão, exigência de dados e motivo por " +
      "transição, responsável/escalonamento, gravação de auditoria + schedule_event em toda " +
      "transição, ações unitárias e em lote, Kanban e calendário.",
  },
  "107283": {
    done: true,
    hours: 28,
    summary:
      "Primitivo de auditoria atômica (audit_log + AuditService.record) na MESMA transação " +
      "(falha → rollback) e trilha append-only schedule_event usada na linha do tempo do " +
      "detalhe da carga (ordem cronológica inversa).",
  },
  "107284": {
    done: true,
    hours: 32,
    summary:
      "Visões Tabela/Kanban/Calendário, quadro de resumo (RN-007), SLA por status " +
      "(slaDeadlineAt/slaState) e visões salvas/preferências de coluna.",
  },
  "107285": {
    done: true,
    hours: 28,
    summary:
      "Tratativas da agenda (POST/GET /schedules/:id/treatments) e detalhe da carga " +
      "(GET /loads/:id/details) via evento schedule.build-load-details, compondo agenda, " +
      "pedidos, itens, linha do tempo e tratativas.",
  },
  "110039": {
    done: true,
    hours: 28,
    summary:
      "CRUD de Transportadores com autocomplete de razão social/nome fantasia por CNPJ " +
      "(global), contatos com finalidade obrigatória e ≥1 contato com nome+e-mail, " +
      "formalização só por E-mail (Hub desabilitado), busca por documento, ativo por padrão e " +
      "auditoria.",
  },
  "110044": {
    done: true,
    hours: 48,
    summary:
      "Serviço de disparo de e-mails desacoplado do provedor (common/mail + SendGrid), 6 " +
      "templates, tabela email_log, envio após COMMIT (afterCommit) que nunca derruba a " +
      "transação, e jobs cron por tenant: carga atrelada (dedup), agenda confirmada, resumo " +
      "diário, escalonamento, solicitação por e-mail (muda status) e reagendamento na mesma " +
      "thread. Divergência: resumo diário roda 06:00 BRT (09:00 UTC), não 08:00 UTC.",
  },
  "110045": {
    done: true,
    hours: 20,
    summary:
      "CRUD de Motivos por tenant com status de destino (não vazio), exigência de explicação " +
      "escrita, unicidade de code por tenant, auditoria e filtro por status para os dropdowns " +
      "de transição (rota GET /reasons?allowedStatus= em vez de /reasons/by-status).",
  },
  "110682": {
    done: true,
    hours: 32,
    summary:
      "Pré-requisitos da Sugestão: origem da data (suggestion_origin com os 4 valores) + " +
      "migração/backfill, importação grava fonte-externa, alteração manual grava " +
      "insercao-manual com log, evento schedule.ready-for-suggestion nos elegíveis, " +
      "customer.priority e peso opcional por item.",
  },
  "110694": {
    done: true,
    hours: 28,
    summary:
      "Status das fontes (regras 7/7/30/30 e precedência) e portão de geração puro " +
      "(bloqueio/alerta/permitido com bases a desconsiderar), com endpoint de status para o " +
      "painel e snapshot anexado à execução.",
  },
  "110698": {
    done: true,
    hours: 56,
    summary:
      "Motor puro e determinístico calculateSuggestedDate (data base→estoque→capacidade→" +
      "feriado origem→elegibilidade→lead time→recebimento→feriado destino), com timeline e " +
      "códigos de erro, leituras de cliente/CD e testes dos exemplos do PRD.",
  },
  "110702": {
    done: true,
    hours: 40,
    summary:
      "Cálculo individual por agenda: portão→motor→aplicação em transação (devolve reservas " +
      "anteriores e reserva as novas), gravação de suggestion_run em todos os desfechos " +
      "(inclusive falha), proteção de datas manual/externa, lock por CD e histórico por " +
      "agenda (rotas /suggestion e /suggestion-runs).",
  },
  "110710": {
    done: true,
    hours: 28,
    summary:
      "Instrumentação MT-001..MT-005 (origem da data, falhas por código, desvios de data, " +
      "importações/ocorrências, duração e erro técnico), consultas de painel, flag de " +
      "habilitação por embarcador (sem deploy) e runbook de virada/rollback. O recorte por " +
      "embarcador é feito nas consultas SQL (métricas sem label de tenant, por cardinalidade).",
  },

  // ---- Não concluídos: apenas Notas do Agente ----
  "110686": {
    done: false,
    notes:
      "Ainda falta para considerar pronto:\n" +
      "- Endpoint GET de uma versão específica dos parâmetros: `findByVersion` existe no " +
      "repositório mas não está exposto por rota.\n" +
      "- `isActiveHoliday(date)` não existe como função nomeada; os feriados são consumidos " +
      "por faixa (GET_HOLIDAYS_IN_RANGE) e a checagem pontual é feita no passo de feriado.\n" +
      "- `addBusinessDays` NÃO considera feriados (comentário explícito em " +
      "`common/time/business-days.ts`), enquanto o critério pede o contrário.\n" +
      "- Não existe tabela de itens do lote; `suggestion_batch` guarda `schedule_ids` em jsonb.\n" +
      "- `nextAllowedWeekday` genérico ausente (há `nextReceivingDay` por cliente).\n" +
      "OK: modelo versionado de parâmetros, CRUD de feriados + frescor, tabelas de execução/" +
      "lote (histórico preservado), util de datas (com virada de mês/ano) e ADRs 0007/0008.",
  },
  "110690": {
    done: false,
    notes:
      "Ainda falta para considerar pronto:\n" +
      "- Devolução de reservas no CANCELAMENTO da agenda não foi ligada: só recálculo/" +
      "reprocesso e substituição manual emitem RELEASE_SCHEDULE_CONSUMPTION " +
      "(`set-suggested-date`, `suggestion-execution.service`); `cancel-scheduling` não emite.\n" +
      "- Histórico de importações sem paginação real (apenas `limit`) e sem cobertura " +
      "explícita de datas.\n" +
      "- Faltam testes de concorrência/idempotência de reservas em banco real.\n" +
      "OK: validador all-or-nothing (com ERRO não grava), regras 1–13/R-003 e 1–12/R-005, " +
      "célula vazia=null, datas passadas em alerta, download de modelos, tabela de reservas, " +
      "saldoLivre e reservar/devolver atômicos (lock por CD).",
  },
  "110706": {
    done: false,
    notes:
      "Ainda falta para considerar pronto:\n" +
      "- Deduplicação por agenda na fila não implementada: a mesma agenda pode ser " +
      "enfileirada mais de uma vez (não há controle in-flight por agenda no worker/enqueuer).\n" +
      "- Retry limitado para falhas técnicas ausente: a varredura só reenfileira agenda sem " +
      "execução ou com `sources_blocked`; `internal_error`/`concurrency_timeout` não são " +
      "reprocessados automaticamente.\n" +
      "- A fila é global por réplica, não serializada por embarcador.\n" +
      "- Varredura com cron fixo (`*/30 * * * *`), sem configuração.\n" +
      "- Ordenação do lote é prioridade ascendente (1 primeiro), enquanto o card diz desc " +
      "(equivalente se 1 = maior prioridade).\n" +
      "OK: worker em memória com shutdown gracioso, gatilho automático (só com parâmetro " +
      "ativo), lote (POST/GET /suggestion-batches) com isolamento de falhas, reprocesso e " +
      "varredura.",
  },
};

function idFromName(name) {
  const m = name.match(/_(\d+)_/);
  return m ? m[1] : null;
}

function main() {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".md"));
  for (const file of files) {
    const id = idFromName(file);
    const data = id && DATA[id];
    if (!data) {
      console.log(`  - ignorado (sem plano): ${file}`);
      continue;
    }

    const full = path.join(DIR, file);
    let content = fs.readFileSync(full, "utf8");

    if (data.done) {
      // Estado -> Concluído
      content = content.replace(/^\*\*Estado:\*\*.*$/m, "**Estado:** Concluído");

      // Adiciona Status/Horas após a linha de ID, se ainda não existir
      if (!/\*\*Status:\*\*/.test(content)) {
        content = content.replace(
          /^(\*\*ID:\*\*.*)$/m,
          `$1\n**Status:** Done\n**Horas Trabalhadas:** ${data.hours}`,
        );
      }

      // Resumo na Descrição
      if (!/✅ Implementado:/.test(content)) {
        content = content.replace(
          /^(## 📝 Descrição\s*)$/m,
          `$1\n✅ Implementado: ${data.summary} Horas registradas: ${data.hours}.`,
        );
      }
      console.log(`  ✓ DONE ${id} (${data.hours}h): ${file}`);
    } else {
      // Apenas Notas do Agente
      if (!/## 🤖 Notas do Agente/.test(content)) {
        content = content.trimEnd() + `\n\n## 🤖 Notas do Agente\n\n${data.notes}\n`;
      }
      console.log(`  ~ NOTAS ${id}: ${file}`);
    }

    fs.writeFileSync(full, content, "utf8");
  }
  console.log("\nConcluído.");
}

main();
