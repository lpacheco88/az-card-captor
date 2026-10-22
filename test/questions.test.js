'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseQuestions, parseCommentAnswers, commentToText, interpretComments } = require('../hub-card.js');

test('parseQuestions: uma pergunta com padrão', () => {
  const md = '# Perguntas ao PM\n\n- **Q-11:** O cliente pode aparecer? — **Padrão:** mostramos o id.\n';
  const qs = parseQuestions(md);
  assert.deepStrictEqual(qs, [{ q: 'Q-11', pergunta: 'O cliente pode aparecer?', padrao: 'mostramos o id.' }]);
});

test('parseQuestions: várias perguntas e id único', () => {
  const md = '## Perguntas ao PM\n\n- **Q-01:** Primeira? — **Padrão:** A\n- Q-02: Segunda? — **Padrão:** B\n';
  const qs = parseQuestions(md);
  assert.strictEqual(qs.length, 2);
  assert.strictEqual(qs[0].q, 'Q-01');
  assert.strictEqual(qs[1].pergunta, 'Segunda?');
});

test('parseQuestions: sem a seção devolve null', () => {
  assert.strictEqual(parseQuestions('# Conteúdo\n\nnada aqui\n'), null);
});

test('parseCommentAnswers: uma Q no comentário', () => {
  assert.deepStrictEqual(parseCommentAnswers('Q-11: pode sim\nsegunda linha'), [{ q: 'Q-11', resposta: 'pode sim\nsegunda linha' }]);
});

test('parseCommentAnswers: várias Qs no mesmo comentário', () => {
  const r = parseCommentAnswers('Q-11: resposta 11\nQ-12: resposta 12');
  assert.deepStrictEqual(r, [{ q: 'Q-11', resposta: 'resposta 11' }, { q: 'Q-12', resposta: 'resposta 12' }]);
});

test('commentToText: remove menção e respeita quebra de linha', () => {
  const html = '<p>Q-11: ok<br><a href="#" data-vss-mention="version:2.0,abc">@Rafael</a></p><p>fim</p>';
  assert.strictEqual(commentToText(html), 'Q-11: ok\n\nfim');
});

const pat = { id: 'pat', uniqueName: 'pat@nstech.com.br' };
const comment = (id, text, who = 'pm', date = '2026-10-22T12:00:00Z') => ({ id, text, createdBy: { id: who, uniqueName: who + '@x' }, createdDate: date });

test('interpretComments: sem id com UMA aberta responde ela', () => {
  const hits = interpretComments([comment(1, 'pode, sem problema')], [{ q: 'Q-11', perguntadoEm: '2026-10-22T10:00:00Z' }], pat);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].q, 'Q-11');
  assert.strictEqual(hits[0].resposta, 'pode, sem problema');
  assert.strictEqual(hits[0].ambiguous, false);
});

test('interpretComments: sem id com VÁRIAS abertas marca ambígua', () => {
  const hits = interpretComments([comment(1, 'resposta solta')], [
    { q: 'Q-11', perguntadoEm: '2026-10-22T10:00:00Z' },
    { q: 'Q-12', perguntadoEm: '2026-10-22T10:00:00Z' },
  ], pat);
  assert.strictEqual(hits.length, 2);
  assert.ok(hits.every(h => h.ambiguous));
});

test('interpretComments: Q explícita entre várias abertas responde só ela', () => {
  const hits = interpretComments([comment(1, 'Q-12: só a doze')], [
    { q: 'Q-11', perguntadoEm: '2026-10-22T10:00:00Z' },
    { q: 'Q-12', perguntadoEm: '2026-10-22T10:00:00Z' },
  ], pat);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].q, 'Q-12');
  assert.strictEqual(hits[0].resposta, 'só a doze');
});

test('interpretComments: ignora comentário do PAT e anterior à pergunta', () => {
  const hits = interpretComments([
    comment(1, 'Q-11: do PAT', 'pat', '2026-10-22T12:00:00Z'),
    comment(2, 'Q-11: antiga', 'pm', '2026-10-22T09:00:00Z'),
  ], [{ q: 'Q-11', perguntadoEm: '2026-10-22T10:00:00Z' }], pat);
  assert.strictEqual(hits.length, 0);
});
