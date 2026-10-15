// update_card_112485.js — grava Descrição + Critérios de Aceite no card 112485
require("dotenv").config();
const axios = require("axios");
const { AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT, AZURE_DEVOPS_PAT } = process.env;
const BASE = `https://dev.azure.com/${AZURE_DEVOPS_ORG}/${AZURE_DEVOPS_PROJECT}/_apis`;
const auth = `Basic ${Buffer.from(":" + AZURE_DEVOPS_PAT).toString("base64")}`;
const ax = axios.create({ headers: { Authorization: auth } });

const ID = 112485;
const TITLE = "Back — Importação em lote de Clientes (onboarding Melitta/Mondelez)";

const DESCRIPTION = `<h3>Contexto (B.O.)</h3>
<ul>
<li>Melitta e Mondelez têm 4.600+ clientes por embarcador; o cadastro manual é inviável.</li>
<li>O <code>POST /customers</code> atual é estrito (valida UF×cidade, forma de agendamento + contatos/portal, dias de recebimento e lead time por CD) e trava o cadastro parcial na primeira carga.</li>
<li>Hoje a única forma de criar a empresa global (CNPJ) é via <code>POST /customers</code> (<code>registerFromTenant</code>); <code>/global-companies</code> só tem GET/PATCH.</li>
</ul>
<h3>Objetivo</h3>
<p>Permitir importação em lote de clientes (planilha + API) com cadastro <strong>parcial completável</strong>, sem afrouxar as regras operacionais (cliente incompleto não entra em seleção/agendamento/e-mails automáticos).</p>
<h3>Escopo</h3>
<ul>
<li>Endpoints de import: prévia (planilha/JSON), confirmação, modelo para download e histórico/relatório.</li>
<li>Flag de completude: <code>customer.is_complete</code> + <code>pending_fields</code> (migração com backfill <code>true</code> para os clientes existentes).</li>
<li>Modo leniente de criação no domínio (import); <code>PUT /customers/:id</code> continua estrito e só marca completo quando nada falta.</li>
<li>Criação do global (CNPJ) no import; divergência de global gera alerta (ADR 0016).</li>
<li>Import em massa do diretório global (restrito ao time do HUB).</li>
</ul>
<h3>Colunas do arquivo</h3>
<ul>
<li>Obrigatórias: <strong>CNPJ, Razão Social, UF, Cidade, Tipo de agendamento</strong>.</li>
<li>Opcionais: Nome fantasia, Forma de agendamento (e demais campos completáveis depois).</li>
</ul>
<h3>Regra de completude</h3>
<p>Um cliente é <strong>completo</strong> quando atende as regras estritas atuais (forma de agendamento + contatos do método — e-mail/telefone/portal —, dias/janela de recebimento, lead time por CD) e tem <strong>canal</strong> preenchido. <code>pending_fields</code> lista exatamente o que falta.</p>
<h3>Decisões de produto (aprovadas)</h3>
<ol>
<li>Campos do import: CNPJ*, Razão Social*, Nome fantasia, UF*, Cidade*, Tipo de agendamento*, Forma de agendamento (* obrigatórios).</li>
<li>Completo exige contatos do método, lead time por CD e canal.</li>
<li>Cliente incompleto aparece com selo e pode ser selecionado com aviso de incompleto.</li>
<li>CNPJ com global divergente: alerta e não trava a linha (mantém o global — ADR 0016).</li>
<li>Upsert por <code>document</code> ou <code>externalCode</code>; reimportação sobrescreve.</li>
<li>Import em massa do diretório global para o time do HUB.</li>
<li>Importação <strong>parcial</strong>: grava as linhas boas e reporta as ruins.</li>
<li>Execução <strong>síncrona com teto</strong> de linhas.</li>
</ol>
<h3>Endpoints propostos</h3>
<ul>
<li><code>GET /customers/imports/template</code> — modelo (CSV/XLSX).</li>
<li><code>POST /customers/imports/preview</code> (planilha) e <code>POST /customers/imports</code> (JSON) — prévia com ocorrências (linha/coluna/motivo/severidade).</li>
<li><code>POST /customers/imports/confirm</code> — grava o lote (sucesso parcial).</li>
<li><code>GET /customers/imports</code> e <code>GET /customers/imports/:id</code> — histórico/relatório.</li>
<li><code>POST /global-companies/imports</code> — import em massa do global (HUB, <code>global-companies:write</code>).</li>
</ul>
<h3>Arquitetura / guardrails</h3>
<ul>
<li>Invariante no domínio; o <code>POST /customers</code> atual fica inalterado (sem quebra de /v1).</li>
<li>Auditoria na mesma transação; tenant isolation em todas as queries; validação do arquivo (teto) antes de consultar o banco; carregar CDs/cidades/clientes em lote (sem N+1).</li>
</ul>`;

const ACCEPTANCE = `<ul>
<li>O import (planilha e API) cria cliente <strong>incompleto</strong> com os campos ausentes em branco, exigindo apenas CNPJ, Razão Social, UF, Cidade e Tipo de agendamento, sem travar nas regras condicionais (forma/contatos/portal/recebimento/lead time).</li>
<li><code>pending_fields</code> lista exatamente o que falta; um cliente vira <code>is_complete=true</code> somente quando tem forma de agendamento + contatos do método + dias/janela de recebimento + lead time por CD + canal.</li>
<li><code>PUT /customers/:id</code> mantém as regras estritas atuais e só completa (<code>is_complete=true</code>) quando nada falta.</li>
<li>Cliente incompleto aparece na listagem com selo "incompleto" e pode ser selecionado com aviso, mas <strong>não</strong> entra em agendamento nem em e-mails automáticos.</li>
<li>CNPJ novo cria o registro global; CNPJ já existente com campo global divergente gera <strong>alerta</strong> e <strong>não</strong> trava a linha (mantém o global, ADR 0016).</li>
<li>Upsert por <code>document</code> ou <code>externalCode</code>; a reimportação sobrescreve os campos enviados.</li>
<li>Importação é de <strong>sucesso parcial</strong>: grava as linhas válidas e reporta as inválidas com linha, coluna, motivo e severidade (ERRO/ALERTA).</li>
<li>Execução <strong>síncrona com teto</strong> de linhas (limite configurável, validado antes de processar).</li>
<li>Existe importação em massa do diretório global (<code>global-companies</code>), restrita ao time do HUB pela client role <code>global-companies:write</code>.</li>
<li>Modelo para download, prévia e histórico/relatório de importações (paginado) disponíveis.</li>
<li>Sem quebra de contrato no <code>POST /customers</code> atual; isolamento por tenant; auditoria na mesma transação; cobertura 100% (statements/functions/lines).</li>
</ul>`;

(async () => {
  const url = `${BASE}/wit/workitems/${ID}?api-version=7.0`;
  const patch = [
    { op: "add", path: "/fields/System.Title", value: TITLE },
    { op: "add", path: "/fields/System.Description", value: DESCRIPTION },
    { op: "add", path: "/fields/Microsoft.VSTS.Common.AcceptanceCriteria", value: ACCEPTANCE },
    { op: "add", path: "/fields/System.History", value: "🤖 Agente: plano fechado com as respostas do produto; descrição e critérios de aceite atualizados." },
  ];
  await ax.patch(url, patch, { headers: { "Content-Type": "application/json-patch+json" } });
  console.log(`✅ Card ${ID} atualizado.`);
})().catch((e) => console.error("ERR", e.response?.status, e.response?.data?.message || e.message));
