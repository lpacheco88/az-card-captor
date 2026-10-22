'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  normTitle, extractCode, parseBackCell, parseScaffoldPlan,
  requirementDescriptionHtml, frontQaDescriptionHtml, guideRef, decideSetParent, scaffoldIterationFor,
} = require('../hub-card.js');

const plan = `# Regras

# Feature 113729 — Solicitação de agendamento por e-mail com documento

Guia: \`guia-entrega-documentos.md\` v1.1 (PRD v1.2).

| Requirement | Back (criar) | Front | QA |
| --- | --- | --- | --- |
| 1 - Tipos de documento | DOC-01 (8h) \`card-DOC-01-tipos-de-documento.md\` | Front — Configurações: Tipos de documento | QA — Tipos de documento |
| 4 - Documentos da agenda e confirmação | DOC-04 (22h), DOC-05 (12h) | Front — Seção Documentos | QA — Anexar e confirmar |

# Feature 113302 — Integração de cargas - TMS Multi

| Requirement | Back (existentes, só citar) | Front | QA |
| --- | --- | --- | --- |
| 1 - Recepção do webhook e credencial do TMS Multi | TMS-01 (113395) | Front — Configuração do TMS Multi | QA — Recepção do webhook |
| 2 - Criação e atualização | TMS-02 (113396), TMS-03 (113397) | — | QA — Criação e atualização |
`;

test('normTitle: sem caixa, acento, travessão/hífen e espaços extras', () => {
  assert.strictEqual(normTitle('  QA — Ação  com   hífen-e travessão '), 'qa acao com hifen e travessao');
  assert.strictEqual(normTitle('Front — Seção   Documentos'), normTitle('front - secao documentos'));
});

test('extractCode: códigos dos planos', () => {
  assert.strictEqual(extractCode('Back — TMS-01 Recepção'), 'TMS-01');
  assert.strictEqual(extractCode('Back — E4-00 Retomada'), 'E4-00');
  assert.strictEqual(extractCode('Front — Configuração'), '');
});

test('parseBackCell: existentes com id e novos com horas/arquivo', () => {
  assert.deepStrictEqual(parseBackCell('TMS-01 (113395)'), [
    { code: 'TMS-01', existingId: 113395, hours: null, file: null },
  ]);
  assert.deepStrictEqual(parseBackCell('DOC-01 (8h) `card-DOC-01-tipos-de-documento.md`'), [
    { code: 'DOC-01', existingId: null, hours: 8, file: 'card-DOC-01-tipos-de-documento.md' },
  ]);
  assert.deepStrictEqual(parseBackCell('DOC-04 (22h), DOC-05 (12,5h)').map(b => [b.code, b.hours]), [
    ['DOC-04', 22], ['DOC-05', 12.5],
  ]);
});

test('parseScaffoldPlan: features, guia e requirements', () => {
  const features = parseScaffoldPlan(plan);
  assert.strictEqual(features.length, 2);
  assert.strictEqual(features[0].id, 113729);
  assert.strictEqual(features[0].guideFile, 'guia-entrega-documentos.md');
  assert.strictEqual(features[0].requirements.length, 2);
  assert.strictEqual(features[0].requirements[0].front, 'Front — Configurações: Tipos de documento');
  assert.strictEqual(features[1].requirements[0].backs[0].existingId, 113395);
  assert.strictEqual(features[1].requirements[1].front, null);
});

test('requirementDescriptionHtml: objetivo, cards e link do guia', () => {
  const [feature] = parseScaffoldPlan(plan);
  const html = requirementDescriptionHtml(feature.requirements[0], feature.guideFile);
  assert.match(html, /<h2>Objetivo<\/h2><p>Tipos de documento<\/p>/);
  assert.match(html, /DOC-01/);
  assert.match(html, /Front — Configurações: Tipos de documento/);
  assert.match(html, /QA — Tipos de documento/);
  assert.match(html, /href="Claude%20outputs\/guia-entrega-documentos.md"/);
});

test('frontQaDescriptionHtml: itens do card back com o código de origem', () => {
  const back = {
    code: 'DOC-01',
    card: { body: '# Conteúdo\n\n# Fora do código\n\n- **Front:** tela de tipos\n- **QA:** criar e inativar\n' },
  };
  const front = frontQaDescriptionHtml('Front', [back]);
  const qa = frontQaDescriptionHtml('QA', [back]);
  assert.match(front, /<strong>DOC-01:<\/strong> tela de tipos/);
  assert.match(qa, /<strong>DOC-01:<\/strong> criar e inativar/);
  assert.ok(!/QA:/.test(front));
});

test('decideSetParent: adiciona, ignora o mesmo pai e recusa outro pai', () => {
  assert.strictEqual(decideSetParent([], 105346), 'add');
  assert.strictEqual(decideSetParent([105346], 105346), 'already');
  assert.strictEqual(decideSetParent([105340], 105346), 'refuse');
  assert.strictEqual(decideSetParent([105340, 105346], 105346), 'refuse');
});

test('scaffoldIterationFor: sprint atual vai para o backlog; as demais mantêm a feature', () => {
  const s21 = 'Squad Varejo\\2026\\2026-S21_(12-10 a 23-10)';
  assert.strictEqual(scaffoldIterationFor(s21, s21), 'Squad Varejo');
  assert.strictEqual(scaffoldIterationFor(s21, 'Squad Varejo\\2026\\2026-S24_(23-11 a 04-12)'), s21);
  assert.strictEqual(scaffoldIterationFor('Squad Varejo', s21), 'Squad Varejo');
});

test('guideRef: prefixa a pasta Claude outputs sem duplicar', () => {
  assert.strictEqual(guideRef('guia-entrega-4-portais.md'), 'Claude outputs/guia-entrega-4-portais.md');
  assert.strictEqual(guideRef('Claude outputs/guia-entrega-tms-multi.md'), 'Claude outputs/guia-entrega-tms-multi.md');
});
