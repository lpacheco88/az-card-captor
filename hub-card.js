#!/usr/bin/env node
// hub-card.js — ciclo de vida de UM card do backend no Azure DevOps (Task Code "Back — ...").
//
//   node hub-card.js features [--epic <id>]                 lista as features/PBIs do épico (para escolher o pai)
//   node hub-card.js tree [--epic <id>] [--out <md>]        lista o épico inteiro (features/PBIs + filhos), somente leitura
//   node hub-card.js get <id>                               mostra o card e o pai
//   node hub-card.js create --card <md> (--parent <id> | --like <taskId>) [--title "..."] [--assign <email>]
//   node hub-card.js scaffold --plan <plano> [--feature <id>] [--dry-run]
//                                                            cria Requirement → Back → Front → QA que faltam
//   node hub-card.js link <id> --card <md>                  liga um card que já existe no Azure ao nosso card
//   node hub-card.js link <id> --related <id> [--dry-run]   cria a relação "Related" entre dois work items
//   node hub-card.js start  (<id> | --card <md>) [--branch <b>]            -> Codificação
//   node hub-card.js review (<id> | --card <md>) --pr <url> [--branch <b>] [--to front,pm,qa] [--no-notify] -> Code review
//   node hub-card.js done   (<id> | --card <md>) [--hours N] [--resumo <md>] [--pr <url>] -> Concluído
//                                                            (sem --hours: OriginalEstimate > estimativa do card)
//   node hub-card.js sync [--dry-run]                        fecha (done) os cards do plano cuja branch já está mergeada na origin/main
//   node hub-card.js rehours <id> [--hours N] [--dry-run]    grava OriginalEstimate=CompletedWork=N (ou estimativa), sem mudar estado
//   node hub-card.js retarget <id> [--dry-run]               move o card para a sprint ATUAL do time (sem mudar estado nem pai)
//   node hub-card.js reparent <id> (--parent <id> | --like <taskId>) move o card para outro pai (e área/iteração)
//   node hub-card.js set-parent <id> --parent <épico 105346> --confirm
//                                                            só a relação pai (Feature → Epic); nada mais muda
//   node hub-card.js describe <id> --md <arquivo>            acrescenta/substitui a seção "🤖 Situação do backend"
//                                                            no fim da Descrição (o texto do PM é preservado)
//   node hub-card.js ask --card <md> [--only Q-11,Q-12] [--dry-run]  publica as perguntas ao PM
//   node hub-card.js answers [--id <azureId>] [--dry-run]    lê as respostas do PM (somente leitura)
//   node hub-card.js answer <id> --q Q-11 --text "..." --fonte "..." [--dry-run]
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
const crypto = require('crypto');

const { AZURE_DEVOPS_ORG: ORG, AZURE_DEVOPS_PROJECT: PROJECT, AZURE_DEVOPS_PAT: PAT, TARGET_EPIC_ID: EPIC } = process.env;
const DEFAULT_TEAM = 'Industria';                        // time padrão do board (HUB_CARD_TEAM sobrescreve)
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

// ---------- estimativa (horas do card = estimativa de dev sênior) ----------
function parseEstimate(v) {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Estimativa do card `.md` (front matter `estimativa:`), achando o arquivo pelo `azure: <id>` em "Claude outputs".
function findCardEstimate(id, cwd = process.cwd()) {
  const dir = path.resolve(cwd, 'Claude outputs');
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = {};
    for (const l of m[1].split('\n')) {
      const kv = l.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
    }
    if (String(fm.azure) === String(id)) return parseEstimate(fm.estimativa);
  }
  return null;
}

// Horas de conclusão: --hours > OriginalEstimate do work item > `estimativa:` do card.
async function resolveDoneHours(id, provided) {
  if (provided !== null && provided !== undefined && provided !== '') return Number(provided);
  const it = await getItem(id, ['Microsoft.VSTS.Scheduling.OriginalEstimate']);
  const oe = Number(it.fields['Microsoft.VSTS.Scheduling.OriginalEstimate']);
  if (Number.isFinite(oe) && oe > 0) return oe;
  return findCardEstimate(id, process.cwd());
}

// ---------- git (somente leitura, no repositório atual — usado só no sync) ----------
function git(args, cwd) {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
function gitOk(args, cwd) {
  try { git(args, cwd); return true; } catch { return false; }
}

// Só create/retarget/reparent podem mexer em System.IterationPath. Os demais comandos são barrados.
function guardNoIteration(cmd, ops) {
  if (cmd === 'create' || cmd === 'retarget' || cmd === 'reparent') return;
  if (ops.some(op => op && typeof op.path === 'string' && op.path.includes('System.IterationPath'))) {
    throw new Error(`Comando "${cmd}" não pode alterar System.IterationPath.`);
  }
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
function planPrFor(id, opt) {
  const row = readPlanRows(planPath(opt)).find(r => String(r.azure) === String(id));
  return row && row.pr ? row.pr : null;
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

// ---------- pessoas / comentários (front, PM, QA) ----------
const PEOPLE_FILE = path.join(__dirname, 'hub-card.people.json');
const NOTIFY_STATE_FILE = path.join(__dirname, 'hub-card.notify-state.json');
const QUESTIONS_STATE_FILE = path.join(__dirname, 'hub-card.questions.json');
const NOTIFY_API = '7.0-preview.3';
const PUBLIC_KEYS = ['front', 'pm', 'qa'];
function selectedPublics(opt, keys = PUBLIC_KEYS) {
  if (!opt || !opt.to) return keys;
  const wanted = String(opt.to).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  return keys.filter(k => wanted.includes(k));
}

function readPeople() {
  try { return JSON.parse(fs.readFileSync(PEOPLE_FILE, 'utf8')); } catch { return { front: [], pm: [], qa: [] }; }
}
function writePeople(p) { fs.writeFileSync(PEOPLE_FILE, JSON.stringify(p, null, 2) + '\n', 'utf8'); }
function readNotifyState() { try { return JSON.parse(fs.readFileSync(NOTIFY_STATE_FILE, 'utf8')); } catch { return {}; } }
function writeNotifyState(s) { fs.writeFileSync(NOTIFY_STATE_FILE, JSON.stringify(s, null, 2) + '\n', 'utf8'); }
function contentHash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16); }
function norm(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
function attr(s) { return esc(String(s)).replace(/"/g, '&quot;'); }

let _epicIds;
async function epicIdentities() {
  if (_epicIds) return _epicIds;
  const epic = Number(EPIC);
  if (!epic) return (_epicIds = []);
  const w = await ax().post(`${BASE}/wit/wiql?api-version=${API}`, {
    query: `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] = ${epic} AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') MODE (Recursive)`,
  });
  const ids = [...new Set((w.data.workItemRelations || []).flatMap(r => [r.source && r.source.id, r.target && r.target.id]).filter(Boolean))];
  const map = new Map();
  for (let i = 0; i < ids.length; i += 200) {
    const r = await ax().get(`${BASE}/wit/workitems?ids=${ids.slice(i, i + 200).join(',')}&fields=System.AssignedTo,System.CreatedBy,System.ChangedBy&api-version=${API}`);
    for (const x of (r.data.value || [])) for (const f of ['System.AssignedTo', 'System.CreatedBy', 'System.ChangedBy']) {
      const v = x.fields[f];
      if (v && typeof v === 'object' && v.id) map.set(v.id, { id: v.id, displayName: v.displayName || '', uniqueName: v.uniqueName || '' });
    }
  }
  return (_epicIds = [...map.values()]);
}

// Busca por e-mail (exato) ou nome (tokens, sem acento). Tenta a API de identidades; cai para o scan do épico (401).
async function resolvePerson(p) {
  const email = p.email && !/confirmar/i.test(p.email) ? p.email : null;
  const term = email || p.name;
  let list = [], source = 'identities';
  try {
    const r = await ax().get(`https://dev.azure.com/${ORG}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(term)}&api-version=7.0`);
    list = (r.data.value || []).map(x => ({ id: x.id, displayName: x.providerDisplayName || x.displayName || '', uniqueName: (x.properties && x.properties.Account && x.properties.Account.$value) || x.uniqueName || '' }));
  } catch { source = 'workitems'; }
  if (!list.length) {
    const all = await epicIdentities();
    if (email) list = all.filter(v => norm(v.uniqueName) === norm(email));
    else {
      const tokens = norm(term).split(/\s+/).filter(Boolean);
      list = all.filter(v => tokens.every(t => norm(`${v.displayName} ${v.uniqueName}`).includes(t)));
    }
  }
  let chosen = null;
  if (email) chosen = list.find(v => norm(v.uniqueName) === norm(email)) || null;
  if (!chosen && list.length === 1) chosen = list[0];
  return { term, source, candidates: list, chosen };
}

function mentionHtml(person) {
  return `<a href="#" data-vss-mention="version:2.0,${person.id}">@${esc(person.displayName || person.name || '')}</a>`;
}

function commentHeader(code, pr) {
  return pr ? `<p>${esc(code)} — PR aberto: <a href="${attr(pr)}">${esc(pr)}</a></p>` : '';
}

// Cabeçalho do notify: --header sobrescreve o padrão "— PR aberto".
function notifyHeader(opt, code, pr) {
  return opt.header ? `<p>${esc(String(opt.header))}</p>` : commentHeader(code, pr);
}

// Remove a quebra de linha que o join do mdToHtml deixa antes de abrir/fechar listas.
function cleanCommentHtml(s) {
  return String(s).replace(/\n(?=<\/?(?:ul|ol|li)\b)/g, '');
}

async function resolvedPeople(publics) {
  const people = readPeople();
  const out = [];
  for (const pub of publics) {
    for (const p of (people[pub] || [])) {
      let person = { ...p };
      if (!person.id) {
        const r = await resolvePerson(person);
        if (r.chosen) person = { ...person, id: r.chosen.id, displayName: r.chosen.displayName, uniqueName: r.chosen.uniqueName };
      }
      if (person.id) out.push({ public: pub, ...person, html: mentionHtml(person) });
    }
  }
  return out;
}

function publishDecision(prev, hash, kind) {
  if (prev && prev.hash === hash && prev.kind === kind) return 'skip';
  return prev ? 'update' : 'new';
}

// Publica um comentário por público (com dedup por hash). dryRun não grava.
async function publishPublic(workItemId, pub, kind, bodyMd, headerHtml, people, dryRun) {
  const state = readNotifyState();
  const key = String(workItemId);
  const prev = state[key] && state[key].comments && state[key].comments[pub];
  const hash = contentHash(`${kind}|${bodyMd}`);
  const decision = publishDecision(prev, hash, kind);
  const mentions = people.map(p => p.html).join(' ');
  const prefix = decision === 'update' ? '<p>Atualização:</p>' : '';
  const html = cleanCommentHtml(`${prefix}${headerHtml || ''}${mdToHtml(bodyMd)}${mentions ? `<p>${mentions}</p>` : ''}`);
  if (decision === 'skip') { console.log(`↩️  ${workItemId} | ${pub} | já publicado (mesmo conteúdo) — ignorado`); return { skipped: true }; }
  if (dryRun) {
    console.log(`\n----- [dry-run] ${workItemId} | ${pub} | ${kind}${decision === 'update' ? ' (Atualização)' : ''} -----`);
    console.log(`mencionados: ${people.map(p => `${p.displayName || p.name} <${p.id}>`).join(', ') || '(nenhum)'}`);
    console.log(html);
    return { skipped: false, html };
  }
  const res = await ax().post(`${BASE}/wit/workItems/${workItemId}/comments?api-version=${NOTIFY_API}`, { text: html }, { headers: { 'Content-Type': 'application/json' } });
  const commentId = res.data && (res.data.id || res.data.commentId);
  state[key] = state[key] || { comments: {}, reviewMentionIds: [] };
  state[key].comments[pub] = { hash, kind, at: new Date().toISOString(), commentId };
  if (kind === 'review') state[key].reviewMentionIds = [...new Set([...(state[key].reviewMentionIds || []), ...people.map(p => p.id)])];
  writeNotifyState(state);
  console.log(`💬 ${workItemId} | ${pub} | ${kind} | comentário ${commentId ?? '?'} publicado (${people.length} menção(ões))`);
  return { skipped: false, html, commentId };
}

// Parser da seção "Fora do código": itens "Front:", "PM:", "QA:" (com ou sem negrito).
function parseForaDoCodigo(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (h && /fora do c[oó]digo/i.test(h[2])) { start = i; level = h[1].length; break; }
  }
  if (start < 0) return null;
  const section = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+/);
    if (h && h[1].length <= level) break;
    section.push(lines[i]);
  }
  const out = { front: [], pm: [], qa: [] };
  let current = null, buffer = null;
  const label = /^\s*(?:[-*]\s*)?\**\s*(front|pm|qa)\s*\**\s*:\s*(.*)$/i;
  const flush = () => {
    if (buffer !== null) {
      const t = buffer.replace(/\s+/g, ' ').trim();
      if (t) out[current].push(t);
      buffer = null;
    }
  };
  for (const raw of section) {
    const line = raw.replace(/\s+$/, '');
    const m = line.match(label);
    if (m) {
      flush();
      current = m[1].toLowerCase();
      buffer = m[2].replace(/\**/g, '').trim() || null;
      continue;
    }
    if (!current) continue;
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flush();
      buffer = bullet[1].replace(/\**/g, '').trim() || null;
      continue;
    }
    const text = line.trim();
    if (!text || /^#{1,6}\s/.test(text)) continue;
    if (buffer !== null) buffer += ' ' + text; else buffer = text;
  }
  flush();
  return out;
}

// Blocos markdown por público, preservando a indentação (listas aninhadas) e juntando continuações.
function foraDoCodigoBlocks(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (h && /fora do c[oó]digo/i.test(h[2])) { start = i; level = h[1].length; break; }
  }
  if (start < 0) return null;
  const section = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+/);
    if (h && h[1].length <= level) break;
    section.push(lines[i]);
  }
  const out = { front: [], pm: [], qa: [] };
  let current = null, baseIndent = 0, last = null;
  const label = /^(\s*)(?:[-*]\s*)?\**\s*(front|pm|qa)\s*\**\s*:\s*(.*)$/i;
  for (const raw of section) {
    const m = raw.match(label);
    if (m) {
      current = m[2].toLowerCase();
      baseIndent = m[1].length;
      const rest = m[3].replace(/\**/g, '').trim();
      last = null;
      if (rest) { last = { indent: 0, text: rest }; out[current].push(last); }
      continue;
    }
    if (!current) continue;
    // Qualquer outro rótulo em negrito (ex.: "DevOps/infra:", "Gabriel Castro:") encerra o público atual.
    if (/^\s*(?:[-*]\s*)?\*\*[^*]+\*\*/.test(raw)) { current = null; last = null; continue; }
    const bullet = raw.match(/^(\s*)[-*]\s+(.*)$/);
    if (bullet) {
      const indent = Math.max(0, bullet[1].length - baseIndent);
      const text = bullet[2].replace(/\**/g, '').trim();
      last = { indent, text };
      out[current].push(last);
      continue;
    }
    const text = raw.trim();
    if (!text) continue;
    if (last) last.text += ' ' + text;
  }
  const blocks = {};
  for (const pub of ['front', 'pm', 'qa']) blocks[pub] = out[pub].map(it => `${' '.repeat(it.indent)}- ${it.text}`).join('\n');
  return blocks;
}

function planNotifyPublics(parsed, to) {
  if (!parsed) return [];
  return to.filter(pub => (parsed[pub] || []).length > 0);
}

async function publishReviewComments(id, card, opt) {
  const blocks = foraDoCodigoBlocks(card.body);
  if (!blocks) { warn(`Card ${card.code || card.name} sem seção "Fora do código"; nada publicado.`); return; }
  const code = card.code || '';
  const pr = String(opt.pr);
  const header = commentHeader(code, pr);
  let any = false;
  for (const pub of selectedPublics(opt)) {
    const bodyMd = blocks[pub] || '';
    if (!bodyMd.trim()) continue;
    any = true;
    const people = await resolvedPeople([pub]);
    if (!people.length) { warn(`${pub}: ninguém resolvido no people.json; comentário não publicado.`); continue; }
    await publishPublic(id, pub, 'review', bodyMd, header, people, !!opt['dry-run']);
  }
  if (!any) warn(`Card ${card.code || card.name}: seção "Fora do código" sem itens Front/PM/QA; nada publicado.`);
}

function mergeCommitShort(cwd, branch, code) {
  const nb = branch ? branch.toLowerCase() : null;
  const nc = code ? `(${code.toLowerCase()})` : null;
  try {
    const merges = git(`log origin/main --merges --format=%h%x09%s -n 500`, cwd).split('\n');
    const m = merges.find(l => { const s = (l.split('\t')[1] || '').toLowerCase(); return (nb && s.includes(nb)) || (nc && s.includes(nc)); });
    if (m) return m.split('\t')[0];
  } catch { /* sem git */ }
  try {
    const lines = git(`log origin/main --format=%h%x09%s -n 2000`, cwd).split('\n');
    const hit = lines.find(l => { const s = (l.split('\t')[1] || '').toLowerCase(); return (nc && s.includes(nc)) || (nb && s.includes(nb)); });
    if (hit) return hit.split('\t')[0];
  } catch { /* sem git */ }
  try { return (branch && git(`rev-parse --short ${branch}`, cwd)) || null; } catch { return null; }
}

function doneReplyText(code, hash) {
  if (!hash) return null;
  return `${code ? code + ' ' : ''}entrou na main (commit ${hash})`;
}

function mentionedForPublics(people, pubs) {
  const out = [], seen = new Set();
  for (const pub of pubs) for (const p of (people[pub] || [])) {
    if (p.id && !seen.has(p.id)) { seen.add(p.id); out.push(p); }
  }
  return out;
}
function hasPublishedComments(state, id) {
  const st = state[String(id)];
  return !!(st && st.comments && PUBLIC_KEYS.some(p => st.comments[p]));
}

// Resposta "entrou na main" (review OU notify publicados antes), marcando os mesmos públicos.
async function publishDoneReply(id, opt) {
  const state = readNotifyState();
  if (!hasPublishedComments(state, id)) return { skipped: true, reason: 'sem comentário anterior' };
  const st = state[String(id)];
  const pubs = PUBLIC_KEYS.filter(p => st.comments[p]);
  const mentioned = mentionedForPublics(readPeople(), pubs);
  if (!mentioned.length) return { skipped: true, reason: 'sem pessoa do people.json' };
  const it = await getItem(id, ['System.WorkItemType', 'System.Title']);
  const code = ((it.fields['System.Title'] || '').match(/^Back\s*[—-]\s*(\S+)/i) || [])[1] || '';
  const branch = opt.branch || planBranchFor(id, opt);
  const hash = mergeCommitShort(process.cwd(), branch, code);
  const text = doneReplyText(code, hash);
  if (!text) return { skipped: true, reason: 'sem hash de merge' };
  const note = opt.note ? String(opt.note).trim() : '';
  const key = contentHash('done|' + text + '|' + note);
  if (st.doneReply === key) return { skipped: true, reason: 'já publicado' };
  const html = `<p>${esc(text)}</p>${note ? `<p>${esc(note)}</p>` : ''}<p>${mentioned.map(p => mentionHtml(p)).join(' ')}</p>`;
  if (opt['dry-run']) { console.log(`\n----- [dry-run] ${id} | entrou na main -----\n${html}`); return { skipped: false, html }; }
  const res = await ax().post(`${BASE}/wit/workItems/${id}/comments?api-version=${NOTIFY_API}`, { text: html }, { headers: { 'Content-Type': 'application/json' } });
  const commentId = res.data && (res.data.id || res.data.commentId);
  st.doneReply = key;
  st.doneReplyId = commentId;
  writeNotifyState(state);
  console.log(`💬 ${id} | entrou na main | comentário ${commentId ?? '?'} publicado (${mentioned.length} menção(ões))`);
  return { skipped: false, html, commentId };
}

async function maybeDoneReply(id, card, opt) {
  const r = await publishDoneReply(id, opt);
  if (r.skipped) console.log(`↩️  ${id} | resposta de done não publicada: ${r.reason}`);
}

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
    let it;
    try {
      it = await getItem(cur, ['System.WorkItemType', 'System.Title', 'System.Parent', 'System.AreaPath', 'System.IterationPath']);
    } catch (e) {
      // O épico pode estar sem leitura para o PAT; a relação pelo id ainda basta para o `get`.
      if (e.response?.status === 404 && cur === Number(EPIC)) {
        chain.push({ id: cur, type: '?', title: '(sem leitura)', area: '-', iteration: '-' });
        break;
      }
      throw e;
    }
    chain.push({ id: cur, type: it.fields['System.WorkItemType'], title: it.fields['System.Title'], area: it.fields['System.AreaPath'], iteration: it.fields['System.IterationPath'] });
    cur = it.fields['System.Parent'];
  }
  return chain;
}
function fmtChain(chain) { return chain.map(c => `${c.id} (${c.type})`).join(' → '); }

// Sprint atual do time (HUB_CARD_TEAM; padrão DEFAULT_TEAM). `--iteration` sobrescreve no chamador.
let _currentIteration;
async function currentIteration() {
  if (_currentIteration) return _currentIteration;
  const team = process.env.HUB_CARD_TEAM || DEFAULT_TEAM;
  const url = `https://dev.azure.com/${ORG}/${encodeURIComponent(PROJECT || '')}/${encodeURIComponent(team)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=${API}`;
  const r = await ax().get(url);
  const it = (r.data.value || [])[0];
  if (!it) fail(`Sem sprint atual para o time "${team}".`);
  return (_currentIteration = it.path);
}
// Usuário autenticado do PAT (identidade usada para atribuir). Cacheado.
let _patUser;
async function patUser() {
  if (_patUser) return _patUser;
  const r = await ax().get(`https://dev.azure.com/${ORG}/_apis/connectionData?api-version=7.0-preview`);
  const u = r.data.authenticatedUser || {};
  const uniqueName = u.providerDisplayName || (u.properties && u.properties.Account && u.properties.Account.$value) || null;
  _patUser = { id: u.id, uniqueName, displayName: u.customDisplayName || u.providerDisplayName || uniqueName };
  return _patUser;
}
function identityOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.toLowerCase();
  return String(v.uniqueName || v.displayName || '').toLowerCase() || null;
}
function sameIdentity(a, b) { const x = identityOf(a), y = identityOf(b); return !!x && !!y && x === y; }
// --assign > HUB_CARD_ASSIGNEE > usuário do PAT. Se o card já for o alvo, retorna null (sem op).
function decideAssignee({ assign, envAssignee, patUser: pat, current } = {}) {
  const target = assign || envAssignee || pat;
  if (!target) return null;
  return sameIdentity(current, target) ? null : target;
}
async function assignedToOp(opt, current) {
  const pat = (await patUser()).uniqueName;
  const value = decideAssignee({ assign: opt.assign, envAssignee: process.env.HUB_CARD_ASSIGNEE, patUser: pat, current });
  return value ? { op: 'add', path: '/fields/System.AssignedTo', value } : null;
}
function who(v) { return !v ? '-' : (typeof v === 'string' ? v : (v.uniqueName || v.displayName || '-')); }

// Resolve o pai, a área e a iteração. A área vem do irmão (--like) ou do pai; a iteração é a
// sprint ATUAL do time (nunca a do irmão), salvo --iteration. Exige pai sob o épico (salvo --any-epic).
async function resolvePlacement(opt) {
  let like = null, parent = opt.parent ? Number(opt.parent) : null;
  if (opt.like) {
    const l = await getItem(opt.like, ['System.WorkItemType', 'System.Parent', 'System.AreaPath']);
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
  const iteration = opt.iteration || await currentIteration();
  return { parent, chain, area, iteration };
}

// ---------- scaffold de requisitos e cards a partir do plano ----------
// Título normalizado para casar plano × Azure: sem caixa, acento, travessão/hífen e espaços extras.
function normTitle(s) {
  return norm(s).replace(/[—–‑-]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function extractCode(s) {
  const m = String(s || '').match(/\b([A-Z][A-Z0-9]*-\d{2})\b/);
  return m ? m[1] : '';
}
function splitTableRow(line) {
  return String(line).trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}
// Back: "TMS-01 (113395)" (já existe) ou "DOC-01 (8h) `card-DOC-01-....md`" (criar).
function parseBackCell(cell) {
  const out = [], seen = new Set();
  const re = /([A-Z][A-Z0-9]*-\d{2})\s*\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(cell))) {
    const after = String(cell).slice(re.lastIndex);
    const fm = after.match(/^\s*`([^`]+)`/);
    const info = m[2].trim();
    const idm = info.match(/^(\d{3,})$/);
    const hm = info.match(/^(\d+(?:[.,]\d+)?)\s*h$/i);
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({
      code: m[1],
      existingId: idm ? Number(idm[1]) : null,
      hours: hm ? Number(hm[1].replace(',', '.')) : null,
      file: fm ? fm[1] : null,
    });
  }
  if (!out.length) {
    const re2 = /([A-Z][A-Z0-9]*-\d{2})/g;
    while ((m = re2.exec(cell))) {
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({ code: m[1], existingId: null, hours: null, file: null });
    }
  }
  return out;
}
function plannedTitle(cell) {
  const t = String(cell || '').trim();
  return !t || /^[—–-]+$/.test(t) ? null : t;
}
// Lê as seções "# Feature <id> — <título>" e as tabelas Requirement | Back | Front | QA.
function parseScaffoldPlan(raw) {
  const lines = String(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  const features = [];
  let cur = null;
  for (const line of lines) {
    const fh = line.match(/^#\s+Feature\s+(\d+)\s*[—–-]\s*(.*?)\s*$/i);
    if (fh) {
      cur = { id: Number(fh[1]), title: fh[2].trim(), guideFile: null, requirements: [] };
      features.push(cur);
      continue;
    }
    if (!cur) continue;
    const gm = line.match(/^\s*Guia:\s*(.*)$/i);
    if (gm && !cur.guideFile) {
      const bt = gm[1].match(/`([^`]+)`/);
      if (bt) cur.guideFile = bt[1];
    }
    if (!line.trim().startsWith('|')) continue;
    const cols = splitTableRow(line);
    if (cols.length < 4) continue;
    if (/^requirement$/i.test(cols[0]) || /^:?-{3,}:?$/.test(cols[1] || '')) continue;
    if (!cols[0] || /^:?-{3,}:?$/.test(cols[0])) continue;
    cur.requirements.push({
      title: cols[0],
      backs: parseBackCell(cols[1]),
      front: plannedTitle(cols[2]),
      qa: plannedTitle(cols[3]),
    });
  }
  return features;
}
function resolveBackCardFile(spec, planDir) {
  if (spec.file) {
    const p = path.isAbsolute(spec.file) ? spec.file : path.resolve(planDir, spec.file);
    return fs.existsSync(p) ? p : null;
  }
  const prefix = `card-${spec.code}-`.toLowerCase();
  const hit = fs.readdirSync(planDir).find(f => f.endsWith('.md') && f.toLowerCase().startsWith(prefix));
  return hit ? path.join(planDir, hit) : null;
}
function guideRef(file) {
  const ref = String(file || '').replace(/\\/g, '/');
  if (!ref) return null;
  return /^Claude outputs\//i.test(ref) ? ref : `Claude outputs/${ref}`;
}
function resolveGuideFile(feature, planDir) {
  if (feature.guideFile) return feature.guideFile;
  for (const req of feature.requirements) for (const b of req.backs) {
    const file = resolveBackCardFile(b, planDir);
    if (!file) continue;
    const m = fs.readFileSync(file, 'utf8').match(/O card completo est[áa] em `([^`]+)`/i);
    if (m) return m[1];
  }
  return null;
}
function requirementDescriptionHtml(req, guideFile) {
  const objective = req.title.replace(/^\s*\d+\s*[-—–]\s*/, '').trim() || req.title;
  const backs = req.backs.map(b => b.existingId ? `${b.code} (Azure ${b.existingId})` : b.code).join(', ');
  const items = [];
  if (backs) items.push(`<li><strong>Back:</strong> ${esc(backs)}</li>`);
  if (req.front) items.push(`<li><strong>Front:</strong> ${esc(req.front)}</li>`);
  if (req.qa) items.push(`<li><strong>QA:</strong> ${esc(req.qa)}</li>`);
  const ref = guideRef(guideFile);
  const guide = ref ? `<p><strong>Guia:</strong> <a href="${attr(encodeURI(ref))}">${esc(ref)}</a></p>` : '';
  return `<h2>Objetivo</h2><p>${esc(objective)}</p><h2>Cards</h2><ul>${items.join('')}</ul>${guide}`;
}
function frontQaDescriptionHtml(kind, backs) {
  const key = String(kind).toLowerCase() === 'qa' ? 'qa' : 'front';
  const lines = [];
  for (const b of backs) {
    if (!b.card) continue;
    const parsed = parseForaDoCodigo(b.card.body);
    for (const item of (parsed?.[key] || [])) lines.push(`- **${b.code}:** ${item}`);
  }
  return lines.length ? mdToHtml(lines.join('\n')) : '';
}
// Mesma consulta do `tree`, mas com a feature como raiz, e todos os níveis.
async function featureDescendants(rootId) {
  const w = await ax().post(`${BASE}/wit/wiql?api-version=${API}`, {
    query: `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] = ${Number(rootId)} AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') MODE (Recursive)`,
  });
  const ids = [...new Set((w.data.workItemRelations || []).map(r => r.target?.id).filter(Boolean))].filter(id => id !== Number(rootId));
  const fields = ['System.Id', 'System.WorkItemType', 'System.State', 'System.Title', 'System.Parent', 'System.AreaPath', 'System.IterationPath', 'Microsoft.VSTS.Scheduling.OriginalEstimate'];
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await ax().get(`${BASE}/wit/workitems?ids=${ids.slice(i, i + 200).join(',')}&fields=${fields.join(',')}&api-version=${API}`);
    items.push(...(r.data.value || []));
  }
  return items;
}
// A feature está sob o épico? Para sem ler o épico (que pode negar leitura): a comparação é pelo id.
async function isUnderEpic(id, epic) {
  let cur = Number(id);
  for (let i = 0; i < 20 && cur; i++) {
    if (cur === Number(epic)) return true;
    const it = await getItem(cur, ['System.WorkItemType', 'System.Parent']);
    const p = it.fields['System.Parent'];
    if (!p) return false;
    cur = Number(p);
  }
  return false;
}
// Itens novos não entram numa sprint que está encerrando: se a feature está na sprint atual do time,
// o scaffold usa o backlog (raiz da iteração). Fora isso, mantém a iteração da feature.
function scaffoldIterationFor(featureIteration, current) {
  const fi = String(featureIteration || '');
  if (current && fi && fi === String(current)) return fi.split('\\')[0];
  return fi;
}
async function createScaffoldItem({ type, title, description, area, iteration, parent, assignee, estimate, acceptance, tags, history }) {
  const ops = [
    { op: 'add', path: '/fields/System.Title', value: title },
    { op: 'add', path: '/fields/System.Description', value: description || '' },
    { op: 'add', path: '/fields/System.AreaPath', value: area },
    { op: 'add', path: '/fields/System.IterationPath', value: iteration },
    { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/${ORG}/_apis/wit/workItems/${parent}` } },
  ];
  if (tags) ops.push({ op: 'add', path: '/fields/System.Tags', value: tags });
  if (estimate !== null && estimate !== undefined) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: estimate });
  if (acceptance) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: acceptance });
  if (assignee) ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: assignee });
  if (history) ops.push({ op: 'add', path: '/fields/System.History', value: history });
  const r = await ax().post(`${BASE}/wit/workitems/$${encodeURIComponent(type)}?api-version=${API}`, ops, PATCH);
  return r.data;
}
async function cmdScaffold(opt) {
  const planFile = path.resolve(req(opt.plan, '--plan'));
  if (!fs.existsSync(planFile)) fail(`Plano não encontrado: ${planFile}`);
  const features = parseScaffoldPlan(fs.readFileSync(planFile, 'utf8'));
  const only = opt.feature ? String(opt.feature).split(',').map(s => Number(s.trim())).filter(Boolean) : null;
  if (only) for (const id of only) if (!features.some(f => f.id === id)) warn(`Feature ${id} não está no plano.`);
  const selected = only ? features.filter(f => only.includes(f.id)) : features;
  if (!selected.length) fail('Nenhuma feature do plano para processar.');
  const epic = Number(opt.epic || EPIC || 105346);
  const planDir = path.dirname(planFile);
  const dryRun = !!opt['dry-run'];
  const planOpt = { ...opt };
  delete planOpt.plan;
  let created = 0;

  for (const feature of selected) {
    console.log(`\n## Feature ${feature.id} — ${feature.title}`);
    let fItem;
    try {
      fItem = await getItem(feature.id, ['System.WorkItemType', 'System.Title', 'System.AreaPath', 'System.IterationPath', 'System.Parent']);
    } catch (e) {
      console.log(`⛔ não consegui ler a feature: ${apiError(e)}`);
      continue;
    }
    let under = false;
    try { under = await isUnderEpic(feature.id, epic); } catch (e) { console.log(`⛔ não consegui verificar o épico: ${apiError(e)}`); continue; }
    if (!under) {
      console.log(`⛔ recusada: feature fora do épico ${epic} (pai: ${fItem.fields['System.Parent'] || '-'}). Nada feito.`);
      continue;
    }
    const area = fItem.fields['System.AreaPath'];
    const featureIteration = fItem.fields['System.IterationPath'];
    let current = null;
    try { current = await currentIteration(); } catch { /* sem sprint atual do time */ }
    const iteration = scaffoldIterationFor(featureIteration, current);
    console.log(`Área: ${area} | Iteração dos itens: ${iteration}${iteration !== featureIteration ? ` (backlog; feature em ${featureIteration})` : ''}`);

    let descendants = [];
    try { descendants = await featureDescendants(feature.id); } catch (e) { console.log(`⛔ não consegui ler os filhos: ${apiError(e)}`); continue; }

    const guideFile = resolveGuideFile(feature, planDir);
    if (!guideFile) console.log('⚠️  guia não identificado; a descrição do Requirement sairá sem link.');
    const problems = [];
    for (const req of feature.requirements) {
      for (const b of req.backs) {
        const file = resolveBackCardFile(b, planDir);
        if (file) { try { b.card = readCard(file); } catch { /* card inválido */ } }
        if (!b.card) problems.push(`${b.code}: card .md não encontrado em ${planDir}`);
      }
    }

    for (const req of feature.requirements) {
      const existingReq = descendants.find(x => x.fields['System.WorkItemType'] === 'Requirement' && normTitle(x.fields['System.Title']) === normTitle(req.title));
      let reqId = existingReq ? existingReq.id : null;
      if (reqId) {
        console.log(`✔ já existe Requirement ${reqId}: ${existingReq.fields['System.Title']}`);
      } else {
        console.log(`${dryRun ? '[dry-run] criaria' : 'criaria'} Requirement: "${req.title}" | pai ${feature.id} | sem estimativa | sem responsável`);
        if (!dryRun) {
          const r = await createScaffoldItem({
            type: 'Requirement', title: req.title, description: requirementDescriptionHtml(req, guideFile),
            area, iteration, parent: feature.id,
          });
          reqId = r.id;
          created++;
          console.log(`✅ Requirement ${reqId}: ${req.title}`);
        }
      }

      for (const b of req.backs) {
        const existing = b.existingId
          ? (descendants.find(x => x.id === b.existingId) || { id: b.existingId, fields: { 'System.WorkItemType': TYPE, 'System.Title': b.card ? `Back — ${b.code} ${b.card.name}` : `Back — ${b.code}` } })
          : descendants.find(x => x.fields['System.WorkItemType'] === TYPE && extractCode(x.fields['System.Title']) === b.code);
        if (existing) {
          console.log(`✔ já existe ${existing.fields['System.WorkItemType'] || TYPE} ${existing.id}: ${existing.fields['System.Title']}`);
          continue;
        }
        if (!b.card) { console.log(`⛔ ${b.code}: sem card .md; Back não criado.`); continue; }
        const estimativa = parseEstimate(b.card.fm.estimativa);
        if (estimativa === null) { console.log(`⛔ ${b.code}: card sem "estimativa:"; Back não criado.`); problems.push(`${b.code}: card sem estimativa`); continue; }
        if (b.hours !== null && b.hours !== estimativa) console.log(`⚠️  ${b.code}: plano ${fmtHours(b.hours)} × card ${fmtHours(estimativa)}; uso a estimativa do card.`);
        const title = `Back — ${b.code} ${b.card.name}`;
        console.log(`${dryRun ? '[dry-run] criaria' : 'criaria'} ${TYPE}: "${title}" | pai ${reqId || '(novo Requirement)'} | estimativa ${estimativa}h`);
        if (dryRun) continue;
        if (!reqId) { console.log(`⛔ ${b.code}: Requirement não criado; Back pulado.`); continue; }
        const pat = await patUser();
        if (!pat.uniqueName) fail('Não consegui resolver o usuário do PAT para atribuir o Back.');
        const { description, acceptance } = splitCard(b.card.body);
        const r = await createScaffoldItem({
          type: TYPE, title, description, area, iteration, parent: reqId,
          assignee: pat.uniqueName, estimate: estimativa, acceptance, tags: TAG,
          history: `🤖 Agente: card ${b.code} criado pelo scaffold do plano de requisitos.`,
        });
        b.existingId = r.id;
        created++;
        console.log(`✅ ${TYPE} ${r.id}: ${title}`);
        writeCardAzure(b.card, r.id);
        upsertPlan(planOpt, { card: b.code, azure: r.id, title, status: r.fields['System.State'] });
      }

      for (const [kind, title, desc] of [['Front', req.front, frontQaDescriptionHtml('Front', req.backs)], ['QA', req.qa, frontQaDescriptionHtml('QA', req.backs)]]) {
        if (!title) continue;
        const existing = descendants.find(x => x.fields['System.WorkItemType'] === TYPE && normTitle(x.fields['System.Title']) === normTitle(title));
        if (existing) {
          console.log(`✔ já existe ${existing.fields['System.WorkItemType'] || TYPE} ${existing.id}: ${existing.fields['System.Title']}`);
          continue;
        }
        console.log(`${dryRun ? '[dry-run] criaria' : 'criaria'} ${TYPE}: "${title}" | pai ${reqId || '(novo Requirement)'} | sem estimativa | sem responsável`);
        if (dryRun) continue;
        if (!reqId) { console.log(`⛔ ${kind}: Requirement não criado; ${kind} pulado.`); continue; }
        const r = await createScaffoldItem({ type: TYPE, title, description: desc, area, iteration, parent: reqId });
        created++;
        console.log(`✅ ${TYPE} ${r.id}: ${title}`);
      }
    }

    if (problems.length) {
      console.log('Não casei:');
      for (const p of [...new Set(problems)]) console.log(`- ${p}`);
    }
  }
  console.log(`\n${dryRun ? '[dry-run] ' : ''}Total: ${created} card(s) criado(s).`);
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

function shortDate(v) {
  if (!v) return '-';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
}

async function cmdTree(opt) {
  const epic = Number(opt.epic || EPIC);
  if (!epic) fail('Informe --epic ou TARGET_EPIC_ID no .env.');
  const w = await ax().post(`${BASE}/wit/wiql?api-version=${API}`, {
    query: `SELECT [System.Id] FROM WorkItemLinks WHERE ([Source].[System.Id] = ${epic} AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward') MODE (Recursive)`,
  });
  const ids = [...new Set((w.data.workItemRelations || []).map(r => r.target?.id).filter(Boolean))].filter(id => id !== epic);
  const fields = [
    'System.Id', 'System.WorkItemType', 'System.State', 'System.Title', 'System.Parent',
    'System.Tags', 'System.IterationPath', 'System.AssignedTo',
    'Microsoft.VSTS.Scheduling.OriginalEstimate', 'Microsoft.VSTS.Scheduling.CompletedWork',
    'System.ChangedDate',
  ];
  const items = [];
  for (let i = 0; i < ids.length; i += 200) {
    const r = await ax().get(`${BASE}/wit/workitems?ids=${ids.slice(i, i + 200).join(',')}&fields=${fields.join(',')}&api-version=${API}`);
    items.push(...r.data.value);
  }
  const byId = new Map(items.map(x => [x.id, x]));
  const kids = new Map();
  for (const x of items) {
    const p = x.fields['System.Parent'];
    if (!p) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(x);
  }
  for (const arr of kids.values()) arr.sort((a, b) => a.id - b.id);

  let epicTitle = '';
  try { epicTitle = (await getItem(epic, ['System.Title'])).fields['System.Title'] || ''; } catch { /* sem título */ }
  const code = t => ((String(t || '').match(/^Back\s*[—–-]\s*(\S+)/i) || [])[1]) || '';
  const cell = v => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const header = [
    '| Id | Task Code | Título | Tipo | Estado | Sprint | Responsável | Estimativa | Concluído | Tags | Alterado |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const row = (x, depth) => {
    const f = x.fields;
    return '| ' + [
      x.id,
      cell(code(f['System.Title'])),
      cell(`${'↳ '.repeat(depth)}${f['System.Title'] || ''}`),
      cell(f['System.WorkItemType']),
      cell(f['System.State']),
      cell(f['System.IterationPath']),
      cell(who(f['System.AssignedTo'])),
      f['Microsoft.VSTS.Scheduling.OriginalEstimate'] ?? '-',
      f['Microsoft.VSTS.Scheduling.CompletedWork'] ?? '-',
      cell(f['System.Tags']),
      cell(shortDate(f['System.ChangedDate'])),
    ].join(' | ') + ' |';
  };

  const roots = kids.get(epic) || [];
  const byState = {};
  for (const x of items) { const s = x.fields['System.State'] || '-'; byState[s] = (byState[s] || 0) + 1; }
  const lines = [`# Épico ${epic}${epicTitle ? ' — ' + epicTitle : ''}`, ''];
  lines.push(`${items.length} itens descendentes${items.length ? ' — ' + Object.entries(byState).map(([s, n]) => `${s}: ${n}`).join(' · ') : ''}`, '');
  if (!roots.length) lines.push('_Sem itens sob o épico._', '');
  for (const root of roots) {
    const f = root.fields;
    lines.push(`## ${root.id} — ${f['System.WorkItemType']} — ${f['System.Title'] || ''}`, '');
    lines.push(...header);
    const walk = (id, depth) => {
      const x = byId.get(id);
      if (!x) return;
      lines.push(row(x, depth));
      for (const c of kids.get(id) || []) walk(c.id, depth + 1);
    };
    walk(root.id, 0);
    lines.push('');
  }
  const md = lines.join('\n');
  if (opt.out) {
    const file = path.resolve(String(opt.out));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, md, 'utf8');
    console.log(`🌳 Épico ${epic}: ${items.length} itens → ${file}`);
  } else {
    process.stdout.write(md + '\n');
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
  const estimativa = parseEstimate(card.fm.estimativa);
  if (estimativa === null) fail(`Card ${card.code || card.name} sem "estimativa:" no cabeçalho; informe no front matter (ex.: estimativa: 8).`);
  if (opt.preview) { fs.writeFileSync(path.resolve(opt.preview), `<h2>${esc(title)}</h2>${description}<hr><h2>Critérios</h2>${acceptance}`, 'utf8'); console.log(`👀 Prévia HTML: ${opt.preview}`); }

  if (!opt.parent && !opt.like) fail('Informe --parent <id da feature> ou --like <id de um Task Code da mesma feature>.');
  if (opt['dry-run'] && !PAT) {
    console.log(`[dry-run] criaria ${TYPE}: "${title}" (sem PAT: pai e épico não verificados)`);
    return;
  }
  const { parent, chain, area, iteration } = await resolvePlacement(opt);
  const assignOp = await assignedToOp(opt, null);
  const assignTarget = assignOp ? assignOp.value : (await patUser()).uniqueName;
  console.log(`Pai: ${fmtChain(chain)}`);
  console.log(`Área: ${area} | Iteração: ${iteration} | Responsável: ${assignTarget}`);
  if (opt['dry-run']) {
    console.log(`[dry-run] criaria ${TYPE}: "${title}" | estimativa ${estimativa}h | descrição ${description.length} chars | critérios ${acceptance.length} chars`);
    console.log(`[dry-run] gravaria azure: <id> em ${path.basename(card.full)} e a linha no plano`);
    return;
  }
  const ops = [
    { op: 'add', path: '/fields/System.Title', value: title },
    { op: 'add', path: '/fields/System.Description', value: description },
    { op: 'add', path: '/fields/System.AreaPath', value: area },
    { op: 'add', path: '/fields/System.IterationPath', value: iteration },
    { op: 'add', path: '/fields/System.Tags', value: TAG },
    { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: estimativa },
    { op: 'add', path: '/fields/System.History', value: `🤖 Agente: card ${esc(card.code || card.name)} criado a partir do plano de cards do backend.` },
    { op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/${ORG}/_apis/wit/workItems/${parent}` } },
  ];
  if (acceptance) ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: acceptance });
  if (assignOp) ops.push(assignOp);
  const r = await ax().post(`${BASE}/wit/workitems/$${encodeURIComponent(TYPE)}?api-version=${API}`, ops, PATCH);
  const id = r.data.id;
  console.log(`✅ Criado ${TYPE} ${id}: ${title}`);
  writeCardAzure(card, id);
  upsertPlan(opt, { card: card.code || card.name, azure: id, title, status: r.data.fields['System.State'] });
}

async function cmdLink(id, opt) {
  if (opt.related) {
    const target = Number(req(opt.related, '--related <id>'));
    const it = await ax().get(`${BASE}/wit/workitems/${id}?$expand=relations&api-version=${API}`);
    const targetIt = await getItem(target, ['System.WorkItemType', 'System.Title']);
    const rels = it.data.relations || [];
    const already = rels.some(r => r.rel === 'System.LinkTypes.Related' && Number((String(r.url).match(/\/workItems\/(\d+)$/i) || [])[1]) === target);
    console.log(`${id} | ${it.data.fields['System.Title']} ↔ Related → ${target} | ${targetIt.fields['System.Title']}`);
    if (already) { console.log(`✔ ${id} já relacionado ao ${target}; nada a fazer.`); return; }
    if (opt['dry-run']) { console.log(`[dry-run] criaria a relação Related ${id} ↔ ${target}; parent e sprint não mudam`); return; }
    const ops = [{ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Related', url: `https://dev.azure.com/${ORG}/_apis/wit/workItems/${target}` } }];
    guardNoIteration('link', ops);
    await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, ops, PATCH);
    console.log(`✅ ${id} ↔ Related → ${target} criado.`);
    return;
  }
  const card = readCard(req(opt.card, '--card'));
  const estimativa = parseEstimate(card.fm.estimativa);
  if (estimativa === null) warn(`Card ${card.code || card.name} sem "estimativa:"; o link segue sem OriginalEstimate.`);
  let title = card.title, state = '', assignOp = null;
  if (!opt['dry-run']) {
    const it = await getItem(id, ['System.WorkItemType', 'System.Title', 'System.State', 'System.AssignedTo']);
    if (it.fields['System.WorkItemType'] !== TYPE) warn(`${id} é ${it.fields['System.WorkItemType']}, não ${TYPE}.`);
    title = it.fields['System.Title']; state = it.fields['System.State'];
    assignOp = await assignedToOp(opt, it.fields['System.AssignedTo']);
    console.log(`🔗 ${id} | ${state} | ${title}${estimativa !== null ? ` | estimativa ${estimativa}h` : ''}${assignOp ? ` | responsável → ${assignOp.value}` : ''}`);
  } else {
    const target = opt.assign || process.env.HUB_CARD_ASSIGNEE || (await patUser()).uniqueName;
    console.log(`[dry-run] ligaria ${id} ao card ${card.code || card.name}${estimativa !== null ? ` (OriginalEstimate = ${estimativa})` : ''} | responsável → ${target}`);
  }
  if (opt['dry-run']) return;
  writeCardAzure(card, id);
  const lops = [];
  if (estimativa !== null) lops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value: estimativa });
  if (assignOp) lops.push(assignOp);
  if (lops.length) {
    guardNoIteration('link', lops);
    await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, lops, PATCH);
    if (estimativa !== null) console.log(`✅ ${id}: OriginalEstimate = ${estimativa}`);
    if (assignOp) console.log(`✅ ${id}: AssignedTo → ${assignOp.value}`);
  }
  upsertPlan(opt, { card: card.code || card.name, azure: id, title, status: state });
}

async function cmdTransition(cmd, id, opt, card) {
  if (cmd === 'review') req(opt.pr, '--pr <link do PR>');
  const provided = opt.hours !== undefined ? Number(String(opt.hours).replace(',', '.')) : null;
  let hours = provided;
  if (cmd === 'done') {
    hours = await resolveDoneHours(id, provided);
    if (hours === null || hours === undefined || !Number.isFinite(hours)) {
      throw new Error(`Sem estimativa para ${id}: OriginalEstimate vazio e card sem "estimativa:"; informe --hours ou preencha o card.`);
    }
  }
  if (hours !== null && (!Number.isFinite(hours) || hours < 0)) fail('--hours deve ser um número ≥ 0.');
  const res = await applyTransition(cmd, id, opt, card, hours);
  if (cmd === 'review') {
    if (opt['no-notify']) console.log('ℹ️  --no-notify: comentários do review pulados.');
    else if (!card) warn('review sem --card: não é possível ler "Fora do código"; nada publicado.');
    else await publishReviewComments(id, card, opt);
  }
  return res;
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

  let current = '?', tags = [], title = card?.title || '', currentAssigned = null, currentCompleted = null;
  if (!opt['dry-run']) {
    const it = await getItem(id, ['System.State', 'System.Tags', 'System.Title', 'System.AssignedTo', 'Microsoft.VSTS.Scheduling.CompletedWork']);
    current = it.fields['System.State']; tags = splitTags(it.fields['System.Tags']); title = it.fields['System.Title'];
    currentAssigned = it.fields['System.AssignedTo'];
    currentCompleted = it.fields['Microsoft.VSTS.Scheduling.CompletedWork'];
    if (current === STATE.done && !opt.force) fail(`${id} já está Concluído. Use --force se for intencional.`);
    if (current === 'Cancelado' && !opt.force) fail(`${id} está Cancelado. Use --force se for intencional.`);
  }
  const ops = [];
  if (current !== target) ops.push({ op: 'add', path: '/fields/System.State', value: target });
  if (!tags.includes(TAG)) ops.push({ op: 'add', path: '/fields/System.Tags', value: [...tags, TAG].join('; ') });
  if (hours !== null) {
    ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: hours });
    if (cmd === 'done') ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: 0 });
  } else if (cmd === 'review' && (currentCompleted === null || currentCompleted === undefined || currentCompleted === '')) {
    // O processo exige Completed Work no estado Code review; inicia em 0.
    ops.push({ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value: 0 });
  }
  ops.push({ op: 'add', path: '/fields/System.History', value: history });
  if (!opt['dry-run']) {
    const assignOp = await assignedToOp(opt, currentAssigned);
    if (assignOp) ops.push(assignOp);
  }
  guardNoIteration(cmd, ops);

  if (opt['dry-run']) {
    const targetAssignee = opt.assign || process.env.HUB_CARD_ASSIGNEE || (await patUser()).uniqueName;
    console.log(`[dry-run] ${id}: estado → ${target}${hours !== null ? ` | horas ${hours}` : ''} | responsável → ${targetAssignee} (se diferente)`);
    console.log(`[dry-run] histórico: ${history.replace(/<[^>]+>/g, '').slice(0, 300)}`);
    return;
  }
  await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, ops, PATCH);
  console.log(`✅ ${id}: ${current} → ${target}${hours !== null ? ` | ${hours}h` : ''}`);
  const planRow = { card: card?.code || card?.name, azure: id, title, branch: opt.branch, status: target, pr: opt.pr };
  if (cmd === 'done' && hours !== null) planRow.hours = hours;
  upsertPlan(opt, planRow);
  if (cmd === 'done') await maybeDoneReply(id, card, opt);
}

// set-parent: só a relação pai. Não mexe em área, iteração, estado, responsável nem descrição.
function decideSetParent(currentParents, target) {
  const parents = [...new Set((currentParents || []).map(Number).filter(Boolean))];
  if (!parents.length) return 'add';
  if (parents.length === 1 && parents[0] === Number(target)) return 'already';
  return 'refuse';
}
async function cmdSetParent(id, opt) {
  const target = Number(req(opt.parent, '--parent <id do épico>'));
  const epic = Number(opt.epic || EPIC || 105346);
  if (target !== epic) fail(`set-parent só aceita o épico ${epic} como pai.`);
  const it = await ax().get(`${BASE}/wit/workitems/${id}?$expand=relations&api-version=${API}`);
  const f = it.data.fields;
  if (f['System.WorkItemType'] !== 'Feature') fail(`${id} é ${f['System.WorkItemType']}, não Feature.`);
  const rels = it.data.relations || [];
  const parents = rels
    .filter(r => r.rel === 'System.LinkTypes.Hierarchy-Reverse')
    .map(r => Number((String(r.url).match(/\/workItems\/(\d+)$/i) || [])[1]))
    .filter(Boolean);
  const decision = decideSetParent(parents, target);
  console.log(`${id} | ${f['System.WorkItemType']} | ${f['System.State']} | ${f['System.Title']}`);
  console.log(`  pai: ${parents.length ? parents.join(', ') : '-'} → ${target}`);
  console.log(`  área: ${f['System.AreaPath']} (inalterada) | iteração: ${f['System.IterationPath']} (inalterada)`);
  if (decision === 'already') { console.log(`✅ ${id} já é filho do épico ${target}; nada a fazer.`); return; }
  if (decision === 'refuse') fail(`${id} já tem outro pai (${parents.join(', ')}); não vou trocar. Use reparent se for o caso.`);
  if (opt['dry-run']) { console.log(`[dry-run] criaria a relação Hierarchy-Reverse ${id} → ${target}; nada mais muda`); return; }
  if (!opt.confirm) { console.warn('⚠️  sem --confirm: nada gravado. Vincular ao épico só com --confirm.'); return; }
  const ops = [{ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/${ORG}/_apis/wit/workItems/${target}` } }];
  guardNoIteration('set-parent', ops);
  await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, ops, PATCH);
  const after = await ax().get(`${BASE}/wit/workitems/${id}?$expand=relations&api-version=${API}`);
  const now = (after.data.relations || [])
    .filter(r => r.rel === 'System.LinkTypes.Hierarchy-Reverse')
    .map(r => Number((String(r.url).match(/\/workItems\/(\d+)$/i) || [])[1]))
    .filter(Boolean);
  console.log(`✅ ${id}: pai → ${now.length ? now.join(', ') : '-'} | área ${after.data.fields['System.AreaPath']} | iteração ${after.data.fields['System.IterationPath']}`);
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
  if (!opt.confirm) { console.warn('⚠️  sem --confirm: nada gravado. O reparent altera a sprint; só com --confirm e por ordem do Luciano.'); return; }
  const ops = [];
  if (idx >= 0 && oldParent !== parent) ops.push({ op: 'remove', path: `/relations/${idx}` });
  if (oldParent !== parent) ops.push({ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `https://dev.azure.com/${ORG}/_apis/wit/workItems/${parent}` } });
  ops.push({ op: 'add', path: '/fields/System.AreaPath', value: area });
  ops.push({ op: 'add', path: '/fields/System.IterationPath', value: iteration });
  ops.push({ op: 'add', path: '/fields/System.History', value: `🤖 Agente: card movido para o pai ${parent} (antes: ${oldParent ?? '-'}).` });
  await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, ops, PATCH);
  console.log(`✅ ${id} movido.`);
}

// Move um card já criado para a sprint atual do time (sem mudar estado nem pai).
async function cmdRetarget(id, opt) {
  const it = await getItem(id, ['System.WorkItemType', 'System.Title', 'System.State', 'System.IterationPath']);
  if (it.fields['System.WorkItemType'] !== TYPE) fail(`${id} é ${it.fields['System.WorkItemType']}, não ${TYPE}.`);
  const to = opt.iteration || await currentIteration();
  const from = it.fields['System.IterationPath'];
  console.log(`${id} | ${it.fields['System.State']} | ${it.fields['System.Title']}`);
  console.log(`  iteração: ${from ?? '-'} → ${to}`);
  if (opt['dry-run']) { console.log('[dry-run] nada gravado'); return; }
  if (!opt.confirm) { console.warn('⚠️  sem --confirm: nada gravado. Mover a sprint só com --confirm e por ordem do Luciano.'); return; }
  if (from === to) { console.log(`✅ ${id} já está na sprint ${to}; nada a fazer.`); return; }
  await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, [
    { op: 'add', path: '/fields/System.IterationPath', value: to },
    { op: 'add', path: '/fields/System.History', value: `🤖 Agente: card movido para a sprint ${to} (antes: ${from ?? '-'}).` },
  ], PATCH);
  console.log(`✅ ${id}: iteração → ${to}`);
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
  guardNoIteration('describe', ops);
  await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, ops, PATCH);
  console.log(`✅ ${id} | ${it.fields['System.State']} | ${it.fields['System.Title']}: seção ${replaced ? 'atualizada' : 'adicionada'}`);
}

async function cmdRehours(id, opt) {
  const row = readPlanRows(planPath(opt)).find(r => String(r.azure) === String(id));
  const it = await getItem(id, ['System.State', 'System.Title', 'System.AssignedTo', 'Microsoft.VSTS.Scheduling.OriginalEstimate', 'Microsoft.VSTS.Scheduling.CompletedWork']);
  const oe = it.fields['Microsoft.VSTS.Scheduling.OriginalEstimate'];
  const cw = it.fields['Microsoft.VSTS.Scheduling.CompletedWork'];
  const title = it.fields['System.Title'];
  const assignOp = await assignedToOp(opt, it.fields['System.AssignedTo']);
  const assignInfo = assignOp ? `${who(it.fields['System.AssignedTo'])} → ${assignOp.value}` : `${who(it.fields['System.AssignedTo'])} (sem alteração)`;
  const originalOnly = !!opt['original-only'];

  if (opt['assign-only']) {
    if (opt['dry-run']) {
      console.log(`[dry-run] ${id} | ${it.fields['System.State']} | ${title}`);
      console.log(`[dry-run] AssignedTo: ${assignInfo}`);
      return;
    }
    if (!assignOp) { console.log(`✅ ${id}: AssignedTo ${assignInfo}`); return; }
    await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, [assignOp], PATCH);
    console.log(`✅ ${id}: AssignedTo ${assignInfo}`);
    return;
  }

  const provided = opt.hours !== undefined ? Number(String(opt.hours).replace(',', '.')) : null;
  let value = provided;
  if (value === null || value === undefined || !Number.isFinite(value)) {
    value = Number.isFinite(Number(oe)) && Number(oe) > 0 ? Number(oe) : findCardEstimate(id, process.cwd());
  }
  if (value === null || value === undefined || !Number.isFinite(value)) {
    throw new Error(`Sem --hours e sem OriginalEstimate/estimativa para ${id}.`);
  }
  if (opt['dry-run']) {
    console.log(`[dry-run] ${id} | ${it.fields['System.State']} | ${title}`);
    console.log(`[dry-run] OriginalEstimate ${oe ?? '-'} → ${value} | CompletedWork ${cw ?? '-'} → ${originalOnly ? '(mantém)' : value} | RemainingWork → ${originalOnly ? '(mantém)' : 0} | AssignedTo: ${assignInfo} | plano: ${row ? row.card : '-'}${originalOnly ? ' (só OriginalEstimate)' : ''}`);
    return;
  }
  const ops = originalOnly
    ? [{ op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value }]
    : [
        { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.OriginalEstimate', value },
        { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.CompletedWork', value },
        { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.RemainingWork', value: 0 },
      ];
  if (assignOp) ops.push(assignOp);
  guardNoIteration('rehours', ops);
  await ax().patch(`${BASE}/wit/workitems/${id}?api-version=${API}`, ops, PATCH);
  console.log(`✅ ${id}: OriginalEstimate ${oe ?? '-'} → ${value}${originalOnly ? '' : ` | CompletedWork ${cw ?? '-'} → ${value} | RemainingWork → 0`}${assignOp ? ` | AssignedTo ${assignInfo}` : ''}`);
  if (!originalOnly) upsertPlan(opt, { card: row?.card || title, azure: Number(id), title, hours: value });
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
      const h = await resolveDoneHours(row.azure, null);
      if (h === null || h === undefined || !Number.isFinite(h)) {
        console.warn(`⚠️  ${row.card} | ${row.azure} | mergeado, mas sem estimativa (OriginalEstimate vazio e card sem "estimativa:"); pulando.`);
        continue;
      }
      if (opt['dry-run']) { console.log(`${row.card} | ${row.azure} | mergeado (${det.reason}) | ${fmtHours(h)} | marcaria Concluído`); continue; }
      const card = { code: row.card, name: row.title, title: row.title };
      await applyTransition('done', Number(row.azure), { ...opt, branch: row.branch }, card, h);
      console.log(`${row.card} | ${row.azure} | mergeado (${det.reason}) | ${fmtHours(h)} | Concluído`);
    } catch (e) {
      console.error(`${row.card} | ${row.azure} | erro: ${String(e.message).split('\n')[0]}`);
    }
  }
  try {
    const collected = [];
    const total = await collectAnswers({ ...opt, fromSync: true }, collected);
    if (total && !opt['dry-run']) {
      const file = writeAnswersReport(collected, opt);
      if (file) console.log(`📝 Relatório: ${file}`);
    }
    console.log(`\nanswers: ${total} resposta(s) nova(s).`);
  } catch (e) {
    warn(`answers falhou: ${String(e.message).split('\n')[0]}`);
  }
}

// ---------- Perguntas ao PM ----------
function readQuestionsState() { try { return JSON.parse(fs.readFileSync(QUESTIONS_STATE_FILE, 'utf8')); } catch { return {}; } }
function writeQuestionsState(s) { fs.writeFileSync(QUESTIONS_STATE_FILE, JSON.stringify(s, null, 2) + '\n', 'utf8'); }

// Lê a seção "Perguntas ao PM": um item "- **Q-11:** pergunta — **Padrão:** ...".
function parseQuestions(md) {
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+(.*)$/);
    if (h && /perguntas?\s+ao\s+pm/i.test(h[2])) { start = i; level = h[1].length; break; }
  }
  if (start < 0) return null;
  const section = [];
  for (let i = start + 1; i < lines.length; i++) {
    const h = lines[i].match(/^(#{1,6})\s+/);
    if (h && h[1].length <= level) break;
    section.push(lines[i]);
  }
  const out = [], seen = new Set();
  for (const raw of section) {
    const m = raw.match(/^\s*(?:[-*]\s+)?(?:\*\*)?(Q-\d+)(?:\*\*)?\s*[:：-]\s*(.*)$/i);
    if (!m) continue;
    const q = m[1].toUpperCase();
    if (seen.has(q)) throw new Error(`Pergunta ${q} duplicada na seção "Perguntas ao PM".`);
    seen.add(q);
    const rest = m[2].replace(/\*\*/g, '').trim();
    const p = rest.match(/^(.*?)\s*(?:—|–|-)\s*Padr[aã]o:\s*(.*)$/i);
    out.push({ q, pergunta: (p ? p[1] : rest).trim(), padrao: (p ? p[2] : '').trim() });
  }
  return out;
}

// HTML de comentário -> texto, removendo as menções (<a data-vss-mention>).
function commentToText(html) {
  let s = String(html || '');
  s = s.replace(/<a\b[^>]*data-vss-mention[^>]*>[\s\S]*?<\/a>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<(li)\b[^>]*>/gi, '- ');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// "Q-11: ..." (ou só "Q-11") em qualquer linha inicia a resposta daquela pergunta.
function parseCommentAnswers(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = []; let cur = null;
  for (const line of lines) {
    const m = line.match(/^\s*(Q-\d+)\s*[:：-]?\s*(.*)$/i);
    if (m) { if (cur) out.push(cur); cur = { q: m[1].toUpperCase(), parts: [m[2]] }; }
    else if (cur) cur.parts.push(line);
  }
  if (cur) out.push(cur);
  return out.map(a => ({ q: a.q, resposta: a.parts.join('\n').trim() })).filter(a => a.resposta);
}

function samePerson(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  return !!a.uniqueName && !!b.uniqueName && String(a.uniqueName).toLowerCase() === String(b.uniqueName).toLowerCase();
}

// Decide as respostas de um card (função pura; usada por answers e pelos testes).
function interpretComments(comments, openQs, pat) {
  const out = [];
  for (const rec of openQs) {
    const since = rec.perguntadoEm ? new Date(rec.perguntadoEm) : null;
    const relevant = (comments || []).filter(c => !samePerson(c.createdBy, pat) && (!since || new Date(c.createdDate) > since));
    let hit = null;
    for (const c of relevant) {
      const parsed = parseCommentAnswers(commentToText(c.text));
      const m = parsed.find(a => a.q === rec.q);
      if (m) { hit = { comment: c, resposta: m.resposta, ambiguous: false }; break; }
    }
    if (!hit) {
      const plain = relevant.filter(c => parseCommentAnswers(commentToText(c.text)).length === 0);
      if (plain.length) {
        const c = plain[plain.length - 1];
        hit = { comment: c, resposta: commentToText(c.text), ambiguous: openQs.length > 1 };
      }
    }
    if (hit) out.push({ q: rec.q, ...hit });
  }
  return out;
}

function questionText(code, q) {
  const padrao = !q.padrao ? '-' : (/[.!?]$/.test(q.padrao) ? q.padrao : q.padrao + '.');
  return `❓ ${code ? code + ' · ' : ''}${q.q} — ${q.pergunta}\nPadrão até a resposta: ${padrao}\nPara responder: comente neste card começando por "${q.q}:".`;
}
function questionHtml(code, q, people, update) {
  const lines = (update ? `Atualização ${q.q}: ` : '') + questionText(code, q);
  const body = lines.split('\n').map(l => `<p>${esc(l)}</p>`).join('');
  const mentions = (people || []).map(mentionHtml).join(' ');
  return body + (mentions ? `<p>${mentions}</p>` : '');
}
async function postComment(id, html) {
  const res = await ax().post(`${BASE}/wit/workItems/${id}/comments?api-version=${NOTIFY_API}`, { text: html }, { headers: { 'Content-Type': 'application/json' } });
  return res.data && (res.data.id || res.data.commentId);
}
async function fetchComments(id) {
  const out = []; let token = null;
  do {
    const url = `${BASE}/wit/workItems/${id}/comments?api-version=${NOTIFY_API}${token ? `&continuationToken=${encodeURIComponent(token)}` : ''}`;
    const r = await ax().get(url);
    out.push(...(r.data.comments || []));
    token = r.data.continuationToken;
  } while (token);
  return out;
}

function findCardByAzureId(id) {
  const dir = path.resolve(process.cwd(), 'Claude outputs');
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const full = path.join(dir, f);
    try {
      if (new RegExp(`^azure:\\s*${Number(id)}\\s*$`, 'm').test(fs.readFileSync(full, 'utf8'))) return readCard(full);
    } catch { /* ignora */ }
  }
  return null;
}

function questionsRegistryPath(opt) {
  return opt && opt.out ? path.resolve(String(opt.out)) : path.resolve(process.cwd(), 'Claude outputs', 'perguntas-pm.md');
}
function questionLink(azureId, commentId) {
  return `https://dev.azure.com/${ORG}/${encodeURIComponent(PROJECT || '')}/_workitems/edit/${azureId}/${commentId ? `?discussionId=${commentId}` : ''}`;
}
function writeQuestionsRegistry(state, opt) {
  const file = questionsRegistryPath(opt);
  if (!fs.existsSync(path.dirname(file))) { warn(`Registro não atualizado: a pasta ${path.dirname(file)} não existe (use --out).`); return; }
  const cards = Object.values(state || {}).filter(c => c && c.questions && Object.keys(c.questions).length);
  cards.sort((a, b) => String(a.card || '').localeCompare(String(b.card || '')) || Number(a.azureId) - Number(b.azureId));
  const openBy = cards.map(c => `${c.card || c.azureId}: ${Object.values(c.questions).filter(q => q.status !== 'respondida').length}`);
  const L = ['# Perguntas ao PM — hub-card', '', `Atualizado em ${new Date().toISOString().slice(0, 10)}.`, ''];
  L.push(`**Abertas por card:** ${openBy.length ? openBy.join(' · ') : 'nenhuma'}`, '');
  if (!cards.length) L.push('_Nenhuma pergunta registrada._', '');
  for (const c of cards) {
    L.push(`## ${c.card || '-'} (Azure ${c.azureId})`, '');
    L.push('| Q | Pergunta | Padrão | Perguntado em | Situação | Resposta | Quem | Quando | Fonte | Link do comentário |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    const qs = Object.values(c.questions).sort((a, b) => (a.status === 'respondida' ? 1 : 0) - (b.status === 'respondida' ? 1 : 0) || String(a.q).localeCompare(String(b.q)));
    for (const q of qs) {
      const cel = v => String(v ?? '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
      L.push(`| ${q.q} | ${cel(q.pergunta)} | ${cel(q.padrao)} | ${cel(q.perguntadoEm ? q.perguntadoEm.slice(0, 10) : '-')} | ${cel(q.status)} | ${cel(q.resposta)} | ${cel(q.respondidoPor)} | ${cel(q.respondidoEm ? q.respondidoEm.slice(0, 10) : '-')} | ${cel(q.fonte)} | ${q.commentId ? `[${q.commentId}](${questionLink(c.azureId, q.commentId)})` : '-'} |`);
    }
    L.push('');
  }
  fs.writeFileSync(file, L.join('\n'), 'utf8');
  console.log(`📝 Registro: ${file}`);
}

async function cmdAsk(opt) {
  const card = readCard(req(opt.card, '--card'));
  if (!card.azure) fail('O card não tem "azure:" no cabeçalho; rode create/link antes.');
  const questions = parseQuestions(card.body);
  if (questions === null) { warn(`Card ${card.code || card.name} sem seção "Perguntas ao PM"; nada publicado.`); return; }
  if (!questions.length) { warn(`Card ${card.code || card.name}: seção "Perguntas ao PM" sem itens; nada publicado.`); return; }
  const only = opt.only ? String(opt.only).split(',').map(s => s.trim().toUpperCase()).filter(Boolean) : null;
  const selected = only ? questions.filter(q => only.includes(q.q)) : questions;
  if (only) for (const qid of only) if (!questions.some(x => x.q === qid)) warn(`--only ${qid}: pergunta não encontrada no card.`);
  if (!selected.length) { warn('Nenhuma pergunta selecionada; nada publicado.'); return; }
  const id = Number(card.azure);
  const code = card.code || ((card.title || '').match(/^Back\s*[—–-]\s*(\S+)/i) || [])[1] || '';
  const state = readQuestionsState();
  state[id] = state[id] || { card: code || card.name, azureId: id, questions: {} };
  state[id].card = code || state[id].card || card.name;
  const people = await resolvedPeople(['pm']);
  if (!people.length) warn('Nenhum PM resolvido no people.json; publicarei sem menção.');
  for (const q of selected) {
    const rec = state[id].questions[q.q];
    if (rec && rec.status === 'respondida') { console.log(`ℹ️  ${id} · ${q.q}: já respondida; não republica.`); continue; }
    const changed = !!(rec && rec.commentId && (rec.pergunta !== q.pergunta || rec.padrao !== q.padrao));
    const html = questionHtml(code, q, people, changed);
    if (opt['dry-run']) {
      console.log(`\n----- [dry-run] ${id} | ${q.q} | ${changed ? 'atualização' : 'nova'} -----`);
      console.log(`mencionados: ${people.map(p => `${p.displayName || p.name} <${p.id}>`).join(', ') || '(nenhum)'}`);
      console.log(html);
      continue;
    }
    const commentId = await postComment(id, html);
    state[id].questions[q.q] = {
      card: code || rec?.card || card.name, azureId: id, q: q.q, pergunta: q.pergunta, padrao: q.padrao,
      perguntadoEm: rec?.perguntadoEm || new Date().toISOString(), commentId,
      status: rec?.status === 'resposta-ambigua' ? 'aberta' : (rec?.status || 'aberta'), resposta: rec?.resposta || null,
      respondidoPor: rec?.respondidoPor || null, respondidoEm: rec?.respondidoEm || null, respostaCommentId: rec?.respostaCommentId || null, fonte: rec?.fonte || null,
    };
    console.log(`❓ ${id} | ${q.q} | ${changed ? 'atualização' : 'pergunta'} publicada (comentário ${commentId})`);
  }
  if (opt['dry-run']) { console.log('\n[dry-run] estado e registro não alterados.'); return; }
  writeQuestionsState(state);
  writeQuestionsRegistry(state, opt);
}

// Nome do relatório de respostas por rodada: AAAA-MM-DD-HHmm (UTC), usando a última resposta lida.
function answersReportStamp(answers, now = new Date()) {
  const dates = (answers || [])
    .map(a => (a.respondidoEm ? new Date(a.respondidoEm) : null))
    .filter(d => d && !Number.isNaN(d.getTime()));
  const last = dates.length ? new Date(Math.max(...dates.map(d => d.getTime()))) : now;
  return last.toISOString().slice(0, 16).replace('T', '-').replace(':', '');
}
// Nunca sobrescreve: se o arquivo da rodada já existe, anexa uma seção nova com data/hora.
function writeAnswersReport(answers, opt) {
  if (!answers || !answers.length) return null;
  const dir = path.resolve(process.cwd(), 'Claude outputs');
  if (!fs.existsSync(dir)) { warn(`Relatório não gerado: a pasta ${dir} não existe.`); return null; }
  const stamp = answersReportStamp(answers);
  const file = path.join(dir, `respostas-pm-${stamp}.md`);
  const exists = fs.existsSync(file);
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  const cell = v => String(v ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const date = iso => iso ? new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '—';
  const link = a => a.respostaCommentId
    ? `[${a.respostaCommentId}](https://dev.azure.com/${ORG}/${encodeURIComponent(PROJECT || '')}/_workitems/edit/${a.azureId}/?discussionId=${a.respostaCommentId})`
    : '—';
  const lines = [];
  if (exists) {
    lines.push('', '---', '', `## Rodada adicional — ${now}`, '');
  } else {
    lines.push(`# Respostas do PM — ${stamp.slice(0, 10)} ${stamp.slice(11, 13)}:${stamp.slice(13)} UTC`, '');
    lines.push('Gerado pelo `hub-card answers`. Somente leitura no Azure; nenhum comentário foi publicado.', '');
  }
  lines.push('| Card | Q | Pergunta | Padrão | Resposta | Situação | Link | Data |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const a of [...answers].sort((x, y) => Number(x.azureId) - Number(y.azureId) || String(x.q).localeCompare(String(y.q)))) {
    lines.push(`| ${cell(a.card || a.azureId)} (${a.azureId}) | ${cell(a.q)} | ${cell(a.pergunta)} | ${cell(a.padrao)} | ${cell(a.resposta)} | ${cell(a.status)} | ${link(a)} | ${date(a.respondidoEm)} |`);
  }
  fs.appendFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

async function collectAnswers(opt, collected = []) {
  const state = readQuestionsState();
  const ids = opt && opt.id ? [Number(opt.id)] : Object.keys(state).map(Number);
  let total = 0;
  for (const id of ids) {
    const c = state[id];
    if (!c || !c.questions) { if (opt && opt.id) warn(`${id}: sem perguntas registradas.`); continue; }
    const open = Object.values(c.questions).filter(q => q.status !== 'respondida');
    if (!open.length) continue;
    let comments;
    try { comments = await fetchComments(id); } catch (e) { warn(`${id}: falha ao ler comentários (${e.response?.status || e.message}); seguindo.`); continue; }
    const pat = await patUser();
    const hits = interpretComments(comments, open, pat);
    for (const hit of hits) {
      const rec = c.questions[hit.q];
      if (!rec || rec.status === 'respondida') continue;
      const who = hit.comment.createdBy || {};
      const when = hit.comment.createdDate || new Date().toISOString();
      if (hit.ambiguous) {
        rec.status = 'resposta-ambigua';
        console.log(`⚠️  ${id} · ${hit.q}: resposta ambígua (${who.displayName || who.uniqueName || who.id}) — decida com answer.`);
      } else {
        rec.status = 'respondida';
        console.log(`✅ ${id} · ${hit.q} — ${String(hit.resposta).split('\n')[0]}`);
      }
      rec.resposta = hit.resposta;
      rec.respondidoPor = who.displayName || who.uniqueName || String(who.id || '-');
      rec.respondidoEm = when;
      rec.respostaCommentId = hit.comment.id;
      rec.fonte = 'azure';
      collected.push({
        azureId: id, card: c.card || rec.card || String(id), q: rec.q || hit.q,
        pergunta: rec.pergunta, padrao: rec.padrao, resposta: rec.resposta,
        status: rec.status, respondidoPor: rec.respondidoPor, respondidoEm: rec.respondidoEm,
        respostaCommentId: rec.respostaCommentId,
      });
      total++;
    }
  }
  if (!(opt && opt['dry-run'])) {
    if (total) writeQuestionsState(state);
    writeQuestionsRegistry(state, opt);
  }
  return total;
}

async function cmdAnswers(opt) {
  const collected = [];
  const total = await collectAnswers(opt, collected);
  if (total && !opt['dry-run']) {
    const file = writeAnswersReport(collected, opt);
    if (file) console.log(`📝 Relatório: ${file}`);
  }
  console.log(total ? `\nanswers: ${total} resposta(s) nova(s).` : 'answers: nenhuma resposta nova.');
}

async function cmdAnswer(id, opt) {
  const qid = String(req(opt.q, '--q')).toUpperCase();
  const text = req(opt.text, '--text');
  const fonte = opt.fonte ? String(opt.fonte) : 'manual';
  const state = readQuestionsState();
  let rec = state[id] && state[id].questions && state[id].questions[qid];
  let cardCode = rec?.card || '';
  if (!rec) {
    const card = opt.card ? readCard(opt.card) : findCardByAzureId(id);
    if (!card) fail(`Pergunta ${qid} não está no estado e não achei o card do Azure ${id} em "Claude outputs" (use --card).`);
    const questions = parseQuestions(card.body);
    const q = (questions || []).find(x => x.q.toUpperCase() === qid);
    if (!q) fail(`Pergunta ${qid} não encontrada no card ${card.code || card.name}.`);
    cardCode = card.code || ((card.title || '').match(/^Back\s*[—–-]\s*(\S+)/i) || [])[1] || card.name;
    state[id] = state[id] || { card: cardCode, azureId: id, questions: {} };
    rec = state[id].questions[qid] = { card: cardCode, azureId: id, q: qid, pergunta: q.pergunta, padrao: q.padrao, perguntadoEm: null, commentId: null, status: 'aberta', resposta: null, respondidoPor: null, respondidoEm: null, respostaCommentId: null, fonte: null };
  }
  const qdef = { q: qid, pergunta: rec.pergunta, padrao: rec.padrao };
  if (!rec.commentId) {
    const people = await resolvedPeople(['pm']);
    if (!people.length) warn('Nenhum PM resolvido no people.json; pergunta sem menção.');
    if (opt['dry-run']) {
      console.log(`\n----- [dry-run] ${id} | ${qid} | publicaria a pergunta antes -----`);
      console.log(questionHtml(cardCode, qdef, people, false));
    } else {
      rec.commentId = await postComment(id, questionHtml(cardCode, qdef, people, false));
      rec.perguntadoEm = new Date().toISOString();
      console.log(`❓ ${id} | ${qid} | pergunta publicada antes (comentário ${rec.commentId})`);
    }
  }
  const answerHtml = `<p>✅ ${esc(qid)} — resposta registrada (fonte: ${esc(fonte)}): ${esc(text)}</p>`;
  if (opt['dry-run']) { console.log(`\n----- [dry-run] ${id} | ${qid} | resposta -----\n${answerHtml}\n\n[dry-run] estado e registro não alterados.`); return; }
  rec.respostaCommentId = await postComment(id, answerHtml);
  const who = await patUser();
  rec.status = 'respondida';
  rec.resposta = text;
  rec.respondidoPor = who.displayName || who.uniqueName || '-';
  rec.respondidoEm = new Date().toISOString();
  rec.fonte = fonte;
  if (!rec.perguntadoEm) rec.perguntadoEm = new Date().toISOString();
  writeQuestionsState(state);
  writeQuestionsRegistry(state, opt);
  console.log(`✅ ${id} | ${qid} | resposta publicada (comentário ${rec.respostaCommentId})`);
}

async function cmdNotify(id, opt) {
  const to = String(opt.to || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!to.length) fail('Informe --to front,pm,qa.');
  for (const p of to) if (!PUBLIC_KEYS.includes(p)) fail(`Público inválido: "${p}" (use front,pm,qa).`);
  if (!opt.md) fail('Informe --md <arquivo>.');
  const raw = fs.readFileSync(path.resolve(opt.md), 'utf8').replace(/^\uFEFF/, '');
  const blocks = foraDoCodigoBlocks(raw);
  if (!blocks) { warn(`Arquivo ${path.basename(String(opt.md))} sem seção "Fora do código"; nada publicado.`); return; }
  const pubs = to.filter(pub => (blocks[pub] || '').trim());
  if (!pubs.length) { warn('Nenhum público escolhido tem itens em "Fora do código"; nada publicado.'); return; }
  const it = await getItem(id, ['System.WorkItemType', 'System.Title']);
  const code = ((it.fields['System.Title'] || '').match(/^Back\s*[—-]\s*(\S+)/i) || [])[1] || '';
  let pr = typeof opt.pr === 'string' ? opt.pr : '';
  if (!pr && opt.pr === true) pr = planPrFor(id, opt) || '';
  if (opt.pr && !pr) warn(`PR não informado e não encontrado no plano para ${id}; comentário sem link.`);
  const header = notifyHeader(opt, code, pr);
  for (const pub of pubs) {
    const people = await resolvedPeople([pub]);
    if (!people.length) { warn(`${pub}: ninguém resolvido no people.json; nenhum comentário.`); continue; }
    await publishPublic(id, pub, 'notify', blocks[pub], header, people, !!opt['dry-run']);
  }
}

async function cmdReply(id, opt) {
  const r = await publishDoneReply(id, opt);
  if (r.skipped) {
    if (r.reason === 'sem comentário anterior') warn(`${id} não tem comentário publicado pelo hub-card; nada publicado.`);
    else warn(`${id}: resposta não publicada (${r.reason}).`);
  }
}

async function cmdPeopleResolve(opt) {
  const people = readPeople();
  let changed = false;
  for (const pub of PUBLIC_KEYS) {
    for (const p of (people[pub] || [])) {
      const r = await resolvePerson(p);
      console.log(`\n[${pub}] ${p.name}${p.email ? ` (${p.email})` : ''} — busca "${r.term}" via ${r.source}`);
      if (!r.candidates.length) { console.log('  nenhum candidato'); continue; }
      r.candidates.forEach(c => console.log(`  id=${c.id} | ${c.displayName} | ${c.uniqueName}${r.chosen && r.chosen.id === c.id ? '  <= escolhido' : ''}`));
      if (opt.write && r.chosen) { p.id = r.chosen.id; changed = true; console.log(`  ✅ id gravado: ${p.id}`); }
      else if (!r.chosen) console.log('  (ambíguo; nada gravado — confirme o id)');
    }
  }
  if (opt.write && changed) { writePeople(people); console.log('\npeople.json atualizado.'); }
  else if (!opt.write) console.log('\n(dry: nada gravado; use --write após confirmar)');
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
    case 'tree': return cmdTree(opt);
    case 'get': return cmdGet(Number(req(pos[0], '<id>')));
    case 'create': return cmdCreate(opt);
    case 'scaffold': return cmdScaffold(opt);
    case 'link': return cmdLink(Number(req(pos[0], '<id>')), opt);
    case 'reparent': return cmdReparent(Number(req(pos[0], '<id>')), opt);
    case 'set-parent': return cmdSetParent(Number(req(pos[0], '<id>')), opt);
    case 'describe': return cmdDescribe(Number(req(pos[0], '<id>')), opt);
    case 'sync': return cmdSync(opt);
    case 'rehours': return cmdRehours(Number(req(pos[0], '<id>')), opt);
    case 'retarget': return cmdRetarget(Number(req(pos[0], '<id>')), opt);
    case 'notify': return cmdNotify(Number(req(pos[0], '<id>')), opt);
    case 'reply': return cmdReply(Number(req(pos[0], '<id>')), opt);
    case 'ask': return cmdAsk(opt);
    case 'answers': return cmdAnswers(opt);
    case 'answer': return cmdAnswer(Number(req(pos[0], '<id>')), opt);
    case 'people': { if (pos[0] === 'resolve') return cmdPeopleResolve(opt); fail('Uso: people resolve [--write]'); }
    case 'start': case 'review': case 'done': { const { id, card } = idOrCard(); return cmdTransition(cmd, id, opt, card); }
    default:
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 17).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
      process.exit(cmd ? 1 : 0);
  }
}
if (require.main === module) main().catch(e => fail(e.response ? apiError(e) : String(e.message || e)));
module.exports = { mdToHtml, splitCard, readCard, upsertPlan, migratePlanLines, detectMerged, readPlanRows, parseEstimate, findCardEstimate, resolveDoneHours, decideAssignee, sameIdentity, identityOf, guardNoIteration, parseForaDoCodigo, foraDoCodigoBlocks, mentionHtml, commentHeader, notifyHeader, cleanCommentHtml, publishDecision, planNotifyPublics, doneReplyText, mentionedForPublics, hasPublishedComments, selectedPublics, parseQuestions, parseCommentAnswers, commentToText, interpretComments, normTitle, extractCode, parseBackCell, parseScaffoldPlan, requirementDescriptionHtml, frontQaDescriptionHtml, guideRef, decideSetParent, scaffoldIterationFor, answersReportStamp, writeAnswersReport };
