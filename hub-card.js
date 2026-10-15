#!/usr/bin/env node
// hub-card.js — ciclo de vida de UM card do backend no Azure DevOps (Task Code "Back — ...").
//
//   node hub-card.js features [--epic <id>]                 lista as features/PBIs do épico (para escolher o pai)
//   node hub-card.js get <id>                               mostra o card e o pai
//   node hub-card.js create --card <md> (--parent <id> | --like <taskId>) [--title "..."] [--assign <email>]
//   node hub-card.js link <id> --card <md>                  liga um card que já existe no Azure ao nosso card
//   node hub-card.js start  (<id> | --card <md>) [--branch <b>]            -> Codificação
//   node hub-card.js review (<id> | --card <md>) --pr <url> [--branch <b>] -> Code review
//   node hub-card.js done   (<id> | --card <md>) [--hours N] [--resumo <md>] [--pr <url>] -> Concluído
//                                                            (sem --hours: tempo de execução × 1,5 útil / × 2,5 fim de semana)
//   node hub-card.js sync [--dry-run]                        fecha (done) os cards do plano cuja branch já está mergeada na origin/main
//   node hub-card.js rehours <id> [--dry-run]                recalcula o CompletedWork e a coluna Horas do plano, sem mudar o estado
//   node hub-card.js reparent <id> (--parent <id> | --like <taskId>) move o card para outro pai (e área/iteração)
//   node hub-card.js describe <id> --md <arquivo>            acrescenta/substitui a seção "🤖 Situação do backend"
//                                                            no fim da Descrição (o texto do PM é preservado)
//
// Opções comuns: --dry-run (não chama o Azure, mostra o que faria), --plan <arquivo> (padrão:
// "<pasta atual>/Claude outputs/plano-cards.md"), --force (permite mexer em card já Concluído).
// O .env é lido da pasta deste script; o PAT nunca é impresso.
'use strict';
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });
const axios = require('axios');
const { execSync } = require('child_process');

const { AZURE_DEVOPS_ORG: ORG, AZURE_DEVOPS_PROJECT: PROJECT, AZURE_DEVOPS_PAT: PAT, TARGET_EPIC_ID: EPIC } = process.env;
const API = '7.0';
const BASE = `https://dev.azure.com/${ORG}/${encodeURIComponent(PROJECT || '')}/_apis`;
const TYPE = 'Task Code';
const STATE = { start: 'Codificação', review: 'Code review', done: 'Concluído' };
const TAG = 'Hub-Agente';
const PATCH = { headers: { 'Content-Type': 'application/json-patch+json' } };

// ---------- utilidades ----------
function fail(msg) { console.error(`❌ ${msg}`); process.exit(1); }
function warn(msg) { console.warn(`⚠️  ${msg}`); }
function req(v, name) { if (v === undefined || v === true || v === '') fail(`Informe ${name}.`); return v; }
function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) opt[a.slice(2)] = true; else { opt[a.slice(2)] = n; i++; }
    } else pos.push(a);
  }
  return { pos, opt };
}
let _ax;
function ax() {
  if (!ORG || !PROJECT || !PAT) fail('Configure AZURE_DEVOPS_ORG, AZURE_DEVOPS_PROJECT e AZURE_DEVOPS_PAT no .env do azure-worker.');
  if (!_ax) _ax = axios.create({ headers: { Authorization: 'Basic ' + Buffer.from(':' + PAT).toString('base64') } });
  return _ax;
}
function apiError(e) {
  const s = e.response?.status;
  const m = e.response?.data?.message || e.message;
  if (s === 401 || s === 203) return `Azure recusou a autenticação (${s}): confira o PAT (Work Items: Read & write).`;
  return `Azure ${s || ''} ${m}`.trim();
}
async function getItem(id, fields) {
  const f = fields ? `&fields=${fields.join(',')}` : '';
  const r = await ax().get(`${BASE}/wit/workitems/${id}?api-version=${API}${f}`);
  return r.data;
}
function splitTags(raw) { return String(raw || '').split(';').map(t => t.trim()).filter(Boolean); }
function today() { return new Date().toISOString().slice(0, 10); }

// ---------- tempo de execução (America/Sao_Paulo, UTC-3) ----------
const BH_TZ_OFFSET = -3;        // America/Sao_Paulo, sem horário de verão
const DEFAULT_IDLE_GAP_HOURS = 2;

// Próxima meia-noite local (SP) a partir de um instante (ms).
function spNextMidnight(ms) {
  const d = new Date(ms + BH_TZ_OFFSET * 3600 * 1000);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0) - BH_TZ_OFFSET * 3600 * 1000;
  return midnight + 24 * 3600 * 1000;
}
// Dia da semana local (SP): 0=domingo … 6=sábado.
function spDow(ms) { return new Date(ms + BH_TZ_OFFSET * 3600 * 1000).getUTCDay(); }

// HUB_CARD_IDLE_GAP_HOURS: intervalo entre pontos de atividade maior que isso não conta (padrão 2h).
function resolveIdleGap() {
  const raw = process.env.HUB_CARD_IDLE_GAP_HOURS;
  const h = raw === undefined || raw === '' ? DEFAULT_IDLE_GAP_HOURS : Number(String(raw).replace(',', '.'));
  return Number.isFinite(h) && h > 0 ? h : DEFAULT_IDLE_GAP_HOURS;
}

// Minutos de atividade em dia útil e em fim de semana: soma intervalos entre pontos consecutivos,
// ignorando intervalos maiores que o idleGap; cada intervalo é dividido nas meia-noites locais.
function activityMinutes(points, idleGapHours) {
  let weekdayMinutes = 0, weekendMinutes = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if ((b - a) / 3600000 > idleGapHours) continue;
    let cur = a;
    while (cur < b) {
      const next = Math.min(spNextMidnight(cur), b);
      const dow = spDow(cur);
      const mins = (next - cur) / 60000;
      if (dow === 0 || dow === 6) weekendMinutes += mins; else weekdayMinutes += mins;
      cur = next;
    }
  }
  return { weekdayMinutes, weekendMinutes };
}

// Mínimo de 0,5h no TEMPO DE EXECUÇÃO (antes do multiplicador, proporcional a cada parte).
// Sem intervalos (por-assunto / sem reflog/commits), o mínimo é classificado pelo dia do início.
// horas = útil × 1,5 + fim de semana × 2,5; arredonda PARA CIMA em múltiplos de 0,5. Nunca 0.
function hoursFromMinutes({ weekdayMinutes, weekendMinutes }, assumedDow = 1) {
  let wdHours = weekdayMinutes / 60;
  let weHours = weekendMinutes / 60;
  const total = wdHours + weHours;
  if (total < 0.5) {
    if (total > 0) { const k = 0.5 / total; wdHours *= k; weHours *= k; }
    else if (assumedDow === 0 || assumedDow === 6) weHours = 0.5;
    else wdHours = 0.5;
  }
  return Math.max(0.5, Math.ceil((wdHours * 1.5 + weHours * 2.5) * 2) / 2);
}

function fmtNum(n) { return String(Math.round(Number(n) * 100) / 100).replace('.', ','); }

// ---------- git (somente leitura, no repositório atual) ----------
function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function gitOk(args, cwd) {
  try { git(args, cwd); return true; } catch { return false; }
}

// Histórico de revisões do card no Azure (para achar Codificação / Code review).
async function getUpdates(id) {
  const r = await ax().get(`${BASE}/wit/workItems/${id}/updates?api-version=${API}`);
  return r.data.value || [];
}

function isGitRepo(cwd) { return gitOk('rev-parse --is-inside-work-tree', cwd); }

// Datas do git para a branch: todas as entradas do reflog, 1º commit após a main e último commit.
function branchGitDates(cwd, branch, mainRef = 'origin/main') {
  const out = { reflogDates: [], firstCommit: null, lastCommit: null };
  if (!branch) return out;
  try {
    const lines = git(`reflog show --date=iso ${branch}`, cwd).split('\n').filter(Boolean);
    out.reflogDates = lines
      .map(l => (l.match(/@\{([^}]+)\}/) || [])[1])
      .filter(Boolean)
      .map(raw => {
        const iso = raw.includes('T') ? raw : raw.replace(' ', 'T').replace(/(\d)[ ]([+-])/, '$1$2');
        const d = new Date(iso);
        return Number.isNaN(d.getTime()) ? null : d.toISOString();
      })
      .filter(Boolean);
  } catch { /* sem reflog (branch apagada/outra máquina) */ }
  try { out.lastCommit = git(`log -1 --format=%cI ${branch}`, cwd); } catch { /* sem branch */ }
  try {
    const revs = git(`log --reverse --format=%cI ${mainRef}..${branch}`, cwd).split('\n').filter(Boolean);
    if (revs.length) out.firstCommit = revs[0];
    else {
      const mb = git(`merge-base ${branch} ${mainRef}`, cwd);
      out.firstCommit = git(`show -s --format=%cI ${mb}`, cwd);
    }
  } catch { /* sem mainRef/branch */ }
  return out;
}

// Todos os commits da branch (datas), para os pontos de atividade.
function branchCommitDates(cwd, branch) {
  try { return git(`log --format=%cI ${branch}`, cwd).split('\n').filter(Boolean); } catch { return []; }
}

// Tempo de execução: início = menor entre reflog (criação), Codificação (Azure) e 1º commit; fim = último commit.
// Pontos de atividade = entradas do reflog + commits da branch; intervalos > idle não contam.
function executionEstimate({ azureStart, reflogDates = [], commitDates = [], firstCommit, lastCommit, idleGapHours = resolveIdleGap() }) {
  const valid = d => d && !Number.isNaN(new Date(d).getTime());
  const ms = d => new Date(d).getTime();
  const creation = reflogDates.length ? Math.min(...reflogDates.map(ms)) : null;
  const cands = [];
  if (valid(creation)) cands.push([creation, 'reflog']);
  if (valid(azureStart)) cands.push([ms(azureStart), 'Codificação']);
  if (valid(firstCommit)) cands.push([ms(firstCommit), 'commit']);
  if (!cands.length) throw new Error('Sem data de início (reflog, Codificação ou commit).');
  cands.sort((a, b) => a[0] - b[0]);
  const [start, startSource] = cands[0];
  // Sem commits disponíveis (por-assunto / branch apagada): fim = início → só o mínimo.
  const end = valid(lastCommit) ? ms(lastCommit) : start;
  const points = [...new Set([start, ...[...reflogDates, ...commitDates].map(ms), end].filter(t => t >= start && t <= end))].sort((a, b) => a - b);
  const { weekdayMinutes, weekendMinutes } = activityMinutes(points, idleGapHours);
  return { startDate: new Date(start).toISOString(), endDate: new Date(end).toISOString(), startSource, endSource: 'commit', weekdayMinutes, weekendMinutes, hours: hoursFromMinutes({ weekdayMinutes, weekendMinutes }, spDow(start)) };
}

// --hours informado tem prioridade e não recebe multiplicador.
function decidedHours(provided, estimatedHours) {
  return provided !== null && provided !== undefined && provided !== '' ? Number(provided) : estimatedHours;
}

async function estimateDoneHours(id, branch) {
  const cwd = process.cwd();
  const inRepo = isGitRepo(cwd);
  if (!inRepo) warn('Fora de um repositório git: sem os pontos de atividade do git.');
  const updates = await getUpdates(id);
  const stateOf = u => (u.fields && u.fields['System.State'] && u.fields['System.State'].newValue) || null;
  const azureStart = (updates.find(u => stateOf(u) === STATE.start) || {}).revisedDate || null;
  const g = inRepo ? branchGitDates(cwd, branch) : { reflogDates: [], firstCommit: null, lastCommit: null };
  const commitDates = inRepo ? branchCommitDates(cwd, branch) : [];
  return executionEstimate({ azureStart, reflogDates: g.reflogDates, commitDates, firstCommit: g.firstCommit, lastCommit: g.lastCommit });
}

// ---------- plano de cards + detecção de merge ----------
function planPath(opt) {
  return opt.plan ? path.resolve(opt.plan) : path.resolve(process.cwd(), 'Claude outputs', 'plano-cards.md');
}
function readPlanRows(file) {
  if (!fs.existsSync(file)) return [];
  const rows = [];
  for (const l of fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
    if (!l.startsWith('|')) continue;
    const cols = l.split('|').slice(1, -1).map(c => c.trim());
    if (cols.length < 7 || cols[0] === 'Card' || /^:?-{3,}/.test(cols[1])) continue;
    rows.push({ card: cols[0], azure: cols[1], title: cols[2], branch: cols[3], status: cols[4], pr: cols[5], hours: cols.length >= 8 ? cols[6] : '' });
  }
  return rows;
}
function planBranchFor(id, opt) {
  const row = readPlanRows(planPath(opt)).find(r => String(r.azure) === String(id));
  return row && row.branch ? row.branch : null;
}

// A branch foi mergeada na mainRef? Por ancestralidade ou pelo assunto do commit (squash / branch apagada).
// Branch sem trabalho próprio (nada desde a criação no reflog) é "aberta", mesmo sendo ancestral da main.
function detectMerged(cwd, branch, code, mainRef = 'origin/main') {
  let ref = null;
  if (branch && gitOk(`rev-parse --verify --quiet origin/${branch}`, cwd)) ref = `origin/${branch}`;
  else if (branch && gitOk(`rev-parse --verify --quiet ${branch}`, cwd)) ref = branch;

  const subjects = git(`log ${mainRef} --format=%s -n 1000`, cwd).split('\n');
  const nb = branch ? branch.toLowerCase() : null;
  const nc = code ? `(${code.toLowerCase()})` : null;
  const subjectHit = subjects.find(s => { const t = s.toLowerCase(); return (nb && t.includes(nb)) || (nc && t.includes(nc)); });

  if (ref) {
    // Reflog: sha da entrada mais antiga (criação) e se houve algum "commit:" próprio da branch.
    let createdSha = null, hasOwnCommit = false;
    try {
      const lines = git(`reflog show --format=%H%x09%gs ${branch}`, cwd).split('\n').filter(Boolean);
      if (lines.length) {
        createdSha = lines[lines.length - 1].split('\t')[0];
        hasOwnCommit = lines.some(l => /^commit/.test((l.split('\t')[1] || '').trim()));
      }
    } catch { /* sem reflog */ }

    const refSha = git(`rev-parse ${ref}`, cwd);

    if (createdSha) {
      // Sem trabalho próprio (mesma ponta da criação ou nenhum "commit:" no reflog) → aberta,
      // mesmo sendo ancestral da main (cobre branch criada/resetada de um commit antigo da main).
      if (refSha === createdSha || !hasOwnCommit) return { merged: false, ref, reason: 'no-own-commits' };
      if (gitOk(`merge-base --is-ancestor ${ref} ${mainRef}`, cwd)) return { merged: true, reason: 'ancestor', ref };
    } else if (gitOk(`merge-base --is-ancestor ${ref} ${mainRef}`, cwd)) {
      // Sem reflog: a ancestralidade só vale com um commit na main citando o código do card.
      if (nc && subjects.some(s => s.toLowerCase().includes(nc))) return { merged: true, reason: 'ancestor-code', ref };
    }
  }

  if (subjectHit) return { merged: true, reason: 'subject', ref, subject: subjectHit };
  return { merged: false, ref };
}
function fmtHours(h) { return `${String(h).replace('.', ',')}h`; }

// ---------- markdown -> HTML (o suficiente para os nossos cards) ----------
function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function inline(s) {
  return s.split(/(`[^`]+`)/).map(p =>
    p.length > 1 && p.startsWith('`') && p.endsWith('`')
      ? `<code>${esc(p.slice(1, -1))}</code>`
      : esc(p).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>'),
  ).join('');
}
function table(rows) {
  const cells = r => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => inline(c.trim()));
  const body = rows.filter(r => !/^\s*\|?\s*:?-{3,}/.test(r));
  const [head, ...rest] = body;
  const th = cells(head).map(c => `<th>${c}</th>`).join('');
  const trs = rest.map(r => `<tr>${cells(r).map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<table border="1" cellpadding="4"><tr>${th}</tr>${trs}</table>`;
}
function mdToHtml(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out = []; let para = []; const list = [];
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const close = (ind = -1) => { while (list.length && list[list.length - 1].indent > ind) out.push(`</li></${list.pop().tag}>`); };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      flush(); close(); const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) code.push(lines[i++]);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue;
    }
    if (!line.trim()) { flush(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); close(); const l = Math.min(6, h[1].length + 2); out.push(`<h${l}>${inline(h[2])}</h${l}>`); continue; }
    if (/^\s*\|/.test(line)) {
      flush(); close(); const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      i--; out.push(table(rows)); continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      flush(); const ind = li[1].length; const tag = /\d/.test(li[2]) ? 'ol' : 'ul';
      const top = list[list.length - 1];
      if (!top || ind > top.indent) { out.push(`<${tag}><li>${inline(li[3])}`); list.push({ indent: ind, tag }); continue; }
      close(ind);
      const t = list[list.length - 1];
      if (t && t.indent === ind && t.tag === tag) out.push(`</li><li>${inline(li[3])}`);
      else {
        if (t && t.indent === ind) out.push(`</li></${list.pop().tag}>`); out.push(`<${tag}><li>${inline(li[3])}`); list.push({ indent: ind, tag }); }
      continue;
    }
    if (list.length && /^\s+/.test(line)) { out.push(' ' + inline(line.trim())); continue; }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) { flush(); close(); out.push(`<blockquote>${inline(bq[1])}</blockquote>`); continue; }
    close(); para.push(line.trim());
  }
  flush(); close();
  return out.join('\n');
}

// ---------- nosso card (.md com front matter) ----------
function readCard(file) {
  const full = path.resolve(file);
  if (!fs.existsSync(full)) fail(`Card não encontrado: ${full}`);
  const raw = fs.readFileSync(full, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fm = {}; let body = raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m) {
    body = raw.slice(m[0].length);
    for (const l of m[1].split('\n')) {
      const kv = l.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
    }
  }
  const title = fm.title || (body.match(/^#\s+(.*)$/m) || [])[1] || path.basename(full, '.md');
  const cm = title.match(/^Card\s+(\S+)\s+[—–-]\s+(.*)$/i);
  return { full, raw, body, fm, title, code: cm ? cm[1] : '', name: cm ? cm[2] : title, azure: fm.azure ? Number(fm.azure) : null };
}
function writeCardAzure(card, id) {
  let raw = card.raw;
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (m) {
    const inner = /^azure:.*$/m.test(m[1]) ? m[1].replace(/^azure:.*$/m, `azure: ${id}`) : `${m[1]}\nazure: ${id}`;
    raw = raw.replace(m[0], `---\n${inner}\n---`);
  } else raw = `---\nazure: ${id}\n---\n\n${raw}`;
  fs.writeFileSync(card.full, raw, 'utf8');
  console.log(`📝 ${path.basename(card.full)}: azure: ${id}`);
}
function splitCard(body) {
  const parts = body.split(/\n(?=#\s)/);
  const isAcc = p => /^#\s+(\d+\.\s*)?(crit[ée]rios?\s+de\s+aceite|testes)/im.test(p.trim().split('\n')[0]);
  return {
    description: mdToHtml(parts.filter(p => !isAcc(p)).join('\n')),
    acceptance: mdToHtml(parts.filter(isAcc).join('\n')),
  };
}

// ---------- plano de cards ----------
// Normaliza as linhas para a tabela de 8 colunas (Card|Azure|Título|Branch|Status|PR|Horas|Atualizado):
// o cabeçalho e as linhas antigas (7 colunas) ganham a célula vazia de "Horas".
function migratePlanLines(lines) {
  const isSep = c => /^:?-{3,}:?$/.test(c);
  return lines.map(l => {
    if (!l.startsWith('|')) return l;
    let cols = l.split('|').slice(1, -1).map(c => c.trim());
    if (cols[0] === 'Card') cols = ['Card', 'Azure', 'Título', 'Branch', 'Status', 'PR', 'Horas', 'Atualizado'];
    else if (isSep(cols[1] || '')) cols = ['---', '---', '---', '---', '---', '---', '---', '---'];
    else if (cols.length === 7) cols = [...cols.slice(0, 6), '', cols[6]];
    else if (cols.length === 6) cols = [...cols.slice(0, 6), ''];
    return `| ${cols.join(' | ')} |`;
  });
}

function upsertPlan(opt, row) {
  const file = opt.plan ? path.resolve(opt.plan) : path.resolve(process.cwd(), 'Claude outputs', 'plano-cards.md');
  if (!fs.existsSync(path.dirname(file))) { warn(`Plano não atualizado: a pasta ${path.dirname(file)} não existe (use --plan).`); return; }
  const head = ['| Card | Azure | Título | Branch | Status | PR | Horas | Atualizado |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  let lines = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n')
    : ['# Plano de cards — backend × Azure DevOps', '', 'Atualizado pelo `hub-card.js` (azure-worker). Uma linha por card; a coluna Azure é a chave.', '', ...head];
  if (!lines.some(l => l.startsWith('| Card | Azure'))) lines.push('', ...head);
  lines = migratePlanLines(lines);
  const cols = l => l.split('|').slice(1, -1).map(c => c.trim());
  const idx = lines.findIndex(l => l.startsWith('|') && cols(l)[1] === String(row.azure));
  const keys = ['card', 'azure', 'title', 'branch', 'status', 'pr', 'hours'];
  const cur = {};
  if (idx >= 0) cols(lines[idx]).forEach((v, i) => { if (keys[i]) cur[keys[i]] = v; });
  const merged = { ...cur };
  for (const k of keys) if (row[k] !== undefined && row[k] !== null && row[k] !== '') merged[k] = String(row[k]);
  const cell = s => String(s || '').replace(/\|/g, '/').replace(/\n/g, ' ');
  const line = `| ${keys.map(k => cell(merged[k])).join(' | ')} | ${today()} |`;
  if (idx >= 0) lines[idx] = line;
  else {
    let last = -1; lines.forEach((l, i) => { if (l.startsWith('|')) last = i; });
    lines.splice(last + 1, 0, line);
  }
  fs.writeFileSync(file, lines.join('\n').replace(/\n*$/, '\n'), 'utf8');
  console.log(`🗂️  Plano atualizado: ${path.relative(process.cwd(), file) || file} (${merged.card || '-'} / ${merged.azure} → ${merged.status})`);
}

async function ancestry(id) {
  const chain = [];
  let cur = Number(id);
  for (let i = 0; i < 8 && cur; i++) {
    const it = await getItem(cur, ['System.WorkItemType', 'System.Title', 'System.Parent', 'System.AreaPath', 'System.IterationPath']);
    chain.push({ id: cur, type: it.fields['System.WorkItemType'], title: it.fields['System.Title'], area: it.fields['System.AreaPath'], iteration: it.fields['System.IterationPath'] });
    cur = it.fields['System.Parent'];
  }
  return chain;
}
function fmtChain(chain) { return chain.map(c => `${c.id} (${c.type})`).join(' → '); }
// Resolve o pai e a área/iteração: com --like, copia do Task Code irmão (é o que garante o mesmo board);
// sem --like, herda do pai. Exige que o pai esteja sob o épico TARGET_EPIC_ID (salvo --any-epic).
async function resolvePlacement(opt) {
  let like = null, parent = opt.parent ? Number(opt.parent) : null;
  if (opt.like) {
    const l = await getItem(opt.like, ['System.WorkItemType', 'System.Parent', 'System.AreaPath', 'System.IterationPath']);
    like = l.fields;
    if (!parent) parent = like['System.Parent'];
    if (!parent) fail(`O card ${opt.like} não tem pai.`);
  }
  if (!parent) fail('Informe --parent <id> ou --like <id de um Task Code da mesma feature>.');
  const chain = await ancestry(parent);
  if (chain[0].type === TYPE) fail(`${parent} é um ${TYPE}; o pai deve ser a feature/requirement.`);
  const epic = Number(opt.epic || EPIC);
  if (epic && !chain.some(c => c.id === epic) && !opt['any-epic']) {
    fail(`O pai ${parent} não está no épico ${epic}: ${fmtChain(chain)}. Use --like <Task Code do board certo> ou --parent de uma feature do épico.`);
  }
  const area = opt.area || (like ? like['System.AreaPath'] : chain[0].area);
  const iteration = opt.iteration || (like ? like['System.IterationPath'] : chain[0].iteration);
  return { parent, chain, area, iteration };
}

// ---------- comandos ----------
async function cmdFeatures(opt) {
  const epic = Number(opt.epic || EPIC);
  if (!epic) fail('Informe --epic ou TARGET_EPIC_ID no .env.');
  const w = await ax().post(`${BASE}/wit/wiql?api-version=${API}`, {
    query: `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] = ${epic} AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') MODE (Recursive)`,
  });
  const ids = [...new Set((w.data.workItemRelations || []).map(r => r.target?.id).filter(Boolean))].filter(id => id !== epic);
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await ax().get(`${BASE}/wit/workitems?ids=${ids.slice(i, i + 200).join(',')}&fields=System.Id,System.WorkItemType,System.State,System.Title,System.Parent&api-version=${API}`);
    items.push(...r.data.value);
  }
  const kids = {};
  items.forEach(x => { const p = x.fields['System.Parent']; if (p && x.fields['System.WorkItemType'] === TYPE) kids[p] = (kids[p] || 0) + 1; });
  const parents = items.filter(x => x.fields['System.WorkItemType'] !== TYPE).sort((a, b) => a.id - b.id);
  console.log(`Épico ${epic}: ${parents.length} itens pai, ${items.length - parents.length} Task Codes\n`);
  for (const x of parents) {
    const f = x.fields;
    console.log(`${x.id} | ${f['System.WorkItemType']} | ${f['System.State']} | ${kids[x.id] || 0} task codes | ${f['System.Title']}`);
  }
}

async function cmdGet(id) {
  const it = await getItem(id, ['System.Id', 'System.WorkItemType', 'System.State', 'System.Title', 'System.Parent', 'System.Tags', 'System.AreaPath', 'System.IterationPath', 'Microsoft.VSTS.Scheduling.CompletedWork']);
  const f = it.fields;
  console.log(`${id} | ${f['System.WorkItemType']} | ${f['System.State']} | ${f['System.Title']}`);
  console.log(`Área: ${f['System.AreaPath']} | Iteração: ${f['System.IterationPath']} | Horas: ${f['Microsoft.VSTS.Scheduling.CompletedWork'] ?? '-'} | Tags: ${f['System.Tags'] || '-'}`);
  if (f['System.Parent']) {
    const chain = await ancestry(f['System.Parent']);
    console.log(`Pais: ${fmtChain(chain)}`);
    chain.forEach(c => console.log(`  ${c.id} | ${c.type} | ${c.title} | ${c.area}`));
    const epic = Number(EPIC);
    if (epic) console.log(chain.some(c => c.id === epic) ? `✅ Dentro do épico ${epic}` : `⚠️  FORA do épico ${epic}`);
  }
}

async function cmdCreate(opt) {
  const card = readCard(req(opt.card, '--card'));
  if (card.azure && !opt.force) fail(`O card já tem azure: ${card.azure}. Use start/review/done (ou --force para criar outro).`);
  const title = opt.title || `Back — ${card.code ? card.code + ' ' : ''}${card.name}`;
  if (!/^back\b/i.test(title) || /front/i.test(title)) warn('O título deve começar com "Back" e não conter "front", senão o worker.js não captura o card.');
  const { description, acceptance } = splitCard(card.body);
  if (opt.preview) { fs.writeFileSync(path.resolve(opt.preview), `<h2>${esc(title)}</h2>${description}<hr><h2>Critérios</h2>${acceptance}`, 'utf8'); console.log(`👀 Prévia HTML: ${opt.preview}`); }

  if (!opt.parent && !opt.like) fail('Informe --parent <id da feature> ou --like <id de um Task Code da mesma feature>.');
  if (opt['dry-run'] && !PAT) {
    console.log(`[dry-run] criaria ${TYPE}: "${title}" (sem PAT: pai e épico não verificados)`);
    return;
  }
  const { parent, chain, area, iteration } = await resolvePlacement(opt);
  console.log(`Pai: ${fmtChain(chain)}`);
  console.log(`Área: ${area} | Iteração: ${iteration}`);
  if (opt['dry-run']) {
    console.log(`[dry-run] criaria ${TYPE}: "${title}" | descrição ${description.length} chars | critérios ${acceptance.length} chars`);
    console.log(`[dry-run] gravaria azure: <id> em ${path.basename(card.full)} e a linha no plano`);
    return;
  }
  const ops = [
    { op: 'add', path: '/fields/System.Title', value: title },
    { op: 'add', path: '/fields/System.Description', value: description },
    { op: 'add', path: '/fields/System.AreaPath', value: area },
    { op: 'add', path: '/fields/System.IterationPath', value: iteration },
    { op: 'add', path: '/fields/System.Tags', value: TAG },
    { op: 'add', path: '/fields/System.History', value: `🤖 Agente: card ${esc(card.code || card.name)} criado a partir do plano de cards do backend.` },
    { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/${ORG}/_apis/wit/workItems/${parent}` } },
  ];
  if (acceptance) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: acceptance });
  if (opt.assign) ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: opt.assign });
  const r = await ax().post(`${BASE}/wit/workitems/$${encodeURIComponent(TYPE)}?api-version=${API}`, ops, PATCH);
  const id = r.data.id;
  console.log(`✅ Criado ${TYPE} ${id}: ${title}`);
  writeCardAzure(card, id);
  upsertPlan(opt, { card: card.code || card.name, azure: id, title, status: r.data.fields['System.State'] });
}

async function cmdLink(id, opt) {
  const card = readCard(req(opt.card, '--card'));
  let title = card.title, state = '';
  if (!opt['dry-run']) {
    const it = await getItem(id, ['System.WorkItemType', 'System.Title', 'System.State']);
    if (it.fields['System.WorkItemType'] !== TYPE) warn(`${id} é ${it.fields['System.WorkItemType']}, não ${TYPE}.`);
    title = it.fields['System.Title']; state = it.fields['System.State'];
    console.log(`🔗 ${id} | ${state} | ${title}`);
  } else console.log(`[dry-run] ligaria ${id} ao card ${card.code || card.name}`);
  if (opt['dry-run']) return;
  writeCardAzure(card, id);
  upsertPlan(opt, { card: card.code || card.name, azure: id, title, status: state });
}

async function cmdTransition(cmd, id, opt, card) {
  if (cmd === 'review') req(opt.pr, '--pr <link do PR>');
  const provided = opt.hours !== undefined ? Number(String(opt.hours).replace(',', '.')) : null;
  let hours = provided;
  if (cmd === 'done') {
    const est = provided === null ? await estimateDoneHours(id, opt.branch || planBranchFor(id, opt)) : null;
    hours = decidedHours(provided, est ? est.hours : null);
  }
  if (hours !== null && (!Number.isFinite(hours) || hours < 0)) fail('--hours deve ser um número ≥ 0.');
  return applyTransition(cmd, id, opt, card, hours);
}

async function applyTransition(cmd, id, opt, card, hours) {
  const target = STATE[cmd];
  const resumo = opt.resumo ? mdToHtml(fs.readFileSync(path.resolve(opt.resumo), 'utf8')) : '';
  let history;
  if (cmd === 'done') {
    history = `🤖 Agente: card concluído.${opt.pr ? ` PR <a href="${esc(String(opt.pr))}">${esc(String(opt.pr))}</a>` : ''}`;
  } else {
    const label = card?.code ? ` (card ${esc(card.code)})` : '';
    const bits = [];
    if (opt.branch) bits.push(`branch <code>${esc(String(opt.branch))}</code>`);
    if (opt.pr) bits.push(`PR <a href="${esc(String(opt.pr))}">${esc(String(opt.pr))}</a>`);
    const msg = { start: 'início da implementação', review: 'PR aberto, em code review', done: 'card concluído' }[cmd];
    history = `🤖 Agente: ${msg}${label}${bits.length ? ' — ' + bits.join(' · ') : ''}.${resumo ? '<br>' + resumo : ''}`;
  }

  let current = '?', tags = [], title = card?.title || '';
  if (!opt['dry-run']) {
    const it = await getItem(id, ['System.State', 'System.Tags', 'System.Title']);
    current = it.fields['System.State']; tags = splitTags(it.fields['System.Tags']); title = it.fields['System.Title'];
    if (current === STATE.done && !opt.force) fail(`${id} já está Concluído. Use --force se for intencional.`);
    if (current === 'Cancelado' && !opt.force) fail(`${id} está Cancelado. Use --force se for intencional.`);
  }
  const ops = [];
  if (current !== target) ops.push({ op: 'add', path: '/fields/System.State', value: target });
  if (!tags.includes(TAG)) ops.push({ op: 'add', path: '/fields/System.Tags', value: [...tags, TAG].join('; ') });
  if (hours !== null) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: hours });
  ops.push({ op: 'add', path: '/fields/System.History', value: history });

  if (opt['dry-run']) {
    console.log(`[dry-run] ${id}: estado → ${target}${hours !== null ? ` | horas ${hours}` : ''}`);
    console.log(`[dry-run] histórico: ${history.replace(/<[^>]+>/g, '').slice(0, 300)}`);
    return;
  }
  await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, ops, PATCH);
  console.log(`✅ ${id}: ${current} → ${target}${hours !== null ? ` | ${hours}h` : ''}`);
  upsertPlan(opt, { card: card?.code || card?.name, azure: id, title, branch: opt.branch, status: target, pr: opt.pr });
}

async function cmdReparent(id, opt) {
  const it = await ax().get(`${BASE}/wit/workitems/${id}?$expand=relations&api-version=${API}`);
  const f = it.data.fields;
  if (f['System.WorkItemType'] !== TYPE) fail(`${id} é ${f['System.WorkItemType']}, não ${TYPE}.`);
  const { parent, chain, area, iteration } = await resolvePlacement(opt);
  const rels = it.data.relations || [];
  const idx = rels.findIndex(r => r.rel === 'System.LinkTypes.Hierarchy-Reverse');
  const oldParent = idx >= 0 ? Number(rels[idx].url.split('/').pop()) : null;
  console.log(`${id} | ${f['System.Title']}`);
  console.log(`  pai: ${oldParent ?? '-'} → ${parent} (${fmtChain(chain)})`);
  console.log(`  área: ${f['System.AreaPath']} → ${area}`);
  console.log(`  iteração: ${f['System.IterationPath']} → ${iteration}`);
  if (opt['dry-run']) { console.log('[dry-run] nada gravado'); return; }
  const ops = [];
  if (idx >= 0 && oldParent !== parent) ops.push({ op: 'remove', path: `/relations/${idx}` });
  if (oldParent !== parent) ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/${ORG}/_apis/wit/workItems/${parent}` } });
  ops.push({ op: 'add', path: '/fields/System.AreaPath', value: area });
  ops.push({ op: 'add', path: '/fields/System.IterationPath', value: iteration });
  ops.push({ op: 'add', path: '/fields/System.History', value: `🤖 Agente: card movido para o pai ${parent} (antes: ${oldParent ?? '-'}).` });
  await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, ops, PATCH);
  console.log(`✅ ${id} movido.`);
}

const SITUACAO = '🤖 Situação do backend';
async function cmdDescribe(id, opt) {
  const file = path.resolve(req(opt.md, '--md <arquivo>'));
  if (!fs.existsSync(file)) fail(`Arquivo não encontrado: ${file}`);
  const md = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const block = `<h3>${SITUACAO} (${today()})</h3>\n${mdToHtml(md)}`;
  if (opt.preview) { fs.writeFileSync(path.resolve(opt.preview), block, 'utf8'); console.log(`👀 Prévia HTML: ${opt.preview}`); }
  if (opt['dry-run']) {
    console.log(`[dry-run] ${id}: substituiria/acrescentaria a seção "${SITUACAO}" (${block.length} chars) no fim da Descrição; estado e critérios não mudam`);
    return;
  }
  const it = await getItem(id, ['System.Description', 'System.Title', 'System.State', 'System.Tags']);
  const cur = it.fields['System.Description'] || '';
  const re = new RegExp(`<h3[^>]*>\\s*${SITUACAO}[\\s\\S]*$`);
  const kept = cur.replace(re, '').trimEnd();
  const replaced = kept.length !== cur.trimEnd().length;
  const tags = splitTags(it.fields['System.Tags']);
  const ops = [
    { op: 'add', path: '/fields/System.Description', value: `${kept}${kept ? '\n' : ''}${block}` },
    { op: 'add', path: '/fields/System.History', value: `🤖 Agente: seção "${SITUACAO}" ${replaced ? 'atualizada' : 'adicionada'} na descrição.` },
  ];
  if (!tags.includes(TAG)) ops.push({ op: 'add', path: '/fields/System.Tags', value: [...tags, TAG].join('; ') });
  await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, ops, PATCH);
  console.log(`✅ ${id} | ${it.fields['System.State']} | ${it.fields['System.Title']}: seção ${replaced ? 'atualizada' : 'adicionada'}`);
}

async function cmdRehours(id, opt) {
  const row = readPlanRows(planPath(opt)).find(r => String(r.azure) === String(id));
  const branch = opt.branch || (row && row.branch) || null;
  const est = await estimateDoneHours(id, branch);
  const it = await getItem(id, ['System.State', 'System.Title', 'Microsoft.VSTS.Scheduling.CompletedWork']);
  const current = it.fields['Microsoft.VSTS.Scheduling.CompletedWork'];
  const title = it.fields['System.Title'];
  if (opt['dry-run']) {
    console.log(`[dry-run] ${id} | ${it.fields['System.State']} | ${title}`);
    console.log(`[dry-run] início: ${est.startSource} ${est.startDate} | fim: ${est.endSource} ${est.endDate}`);
    console.log(`[dry-run] atividade: útil ${Math.round(est.weekdayMinutes)} min × 1,5 + fim de semana ${Math.round(est.weekendMinutes)} min × 2,5 → ${est.hours}h | antes: ${current ?? '-'} | plano: ${row ? row.card : '-'}`);
    return;
  }
  await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, [
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: est.hours },
  ], PATCH);
  console.log(`✅ ${id}: ${current ?? '-'} → ${est.hours}h`);
  upsertPlan(opt, { card: row?.card || title, azure: Number(id), title, branch, hours: est.hours });
}

async function cmdSync(opt) {
  const cwd = process.cwd();
  const file = planPath(opt);
  if (!fs.existsSync(file)) fail(`Plano não encontrado: ${file}`);
  try { git('fetch origin', cwd); } catch (e) { warn(`git fetch origin falhou: ${String(e.message).split('\n')[0]}`); }
  const rows = readPlanRows(file).filter(r => (r.status === STATE.start || r.status === STATE.review) && r.branch);
  console.log(`sync${opt['dry-run'] ? ' (dry-run)' : ''}: ${rows.length} card(s) em andamento em ${path.basename(file)}\n`);
  for (const row of rows) {
    try {
      const det = detectMerged(cwd, row.branch, row.card);
      if (!det.merged) { console.log(`${row.card} | ${row.azure} | aberto | -`); continue; }
      const est = await estimateDoneHours(row.azure, det.ref || row.branch);
      if (opt['dry-run']) { console.log(`${row.card} | ${row.azure} | mergeado (${det.reason}) | ${fmtHours(est.hours)} | marcaria Concluído`); continue; }
      const card = { code: row.card, name: row.title, title: row.title };
      await applyTransition('done', Number(row.azure), { ...opt, branch: row.branch }, card, est.hours);
      console.log(`${row.card} | ${row.azure} | mergeado (${det.reason}) | ${fmtHours(est.hours)} | Concluído`);
    } catch (e) {
      console.error(`${row.card} | ${row.azure} | erro: ${String(e.message).split('\n')[0]}`);
    }
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  const idOrCard = () => {
    const card = opt.card ? readCard(opt.card) : null;
    const id = Number(pos[0] || card?.azure);
    if (!id) fail('Informe o id do Azure ou --card <md> com "azure:" no cabeçalho.');
    return { id, card };
  };
  switch (cmd) {
    case 'features': return cmdFeatures(opt);
    case 'get': return cmdGet(Number(req(pos[0], '<id>')));
    case 'create': return cmdCreate(opt);
    case 'link': return cmdLink(Number(req(pos[0], '<id>')), opt);
    case 'reparent': return cmdReparent(Number(req(pos[0], '<id>')), opt);
    case 'describe': return cmdDescribe(Number(req(pos[0], '<id>')), opt);
    case 'sync': return cmdSync(opt);
    case 'rehours': return cmdRehours(Number(req(pos[0], '<id>')), opt);
    case 'start': case 'review': case 'done': { const { id, card } = idOrCard(); return cmdTransition(cmd, id, opt, card); }
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(cmd ? 1 : 0);
  }
}
if (require.main === module) main().catch(e => fail(e.response ? apiError(e) : String(e.message || e)));
module.exports = { mdToHtml, splitCard, readCard, upsertPlan, activityMinutes, hoursFromMinutes, executionEstimate, decidedHours, resolveIdleGap, spNextMidnight, spDow, migratePlanLines, detectMerged, readPlanRows, branchGitDates, isGitRepo };
