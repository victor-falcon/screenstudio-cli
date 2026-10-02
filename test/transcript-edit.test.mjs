import test from 'node:test';
import assert from 'node:assert/strict';
import { diffWords } from '../dist/cli/word-diff.js';
import { findPhrase, parseEditedTranscript, parseRanges, planTranscriptEdit, renderEditableTranscript } from '../dist/cli/transcript-edit.js';

function tokens(...texts) {
  return texts.map((text, index) => ({
    index, kind: text === null ? 'gap' : 'word', text: text ?? '', sourceStartMs: index * 100, sourceEndMs: index * 100 + 90,
    playbackStartMs: index * 100, present: true, hidden: false, filler: null,
  }));
}

function lcsLength(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (const x of a) {
    let previous = 0;
    for (let j = 1; j <= b.length; j++) {
      const saved = row[j];
      row[j] = x === b[j - 1] ? previous + 1 : Math.max(row[j], row[j - 1]);
      previous = saved;
    }
  }
  return row[b.length];
}

test('word diff reproduces both sequences with a minimal number of edits', () => {
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let round = 0; round < 300; round++) {
    const vocabulary = ['a', 'b', 'c', 'de', 'la'];
    const a = Array.from({ length: Math.floor(random() * 30) }, () => vocabulary[Math.floor(random() * 5)]);
    const b = a.filter(() => random() > 0.3);
    if (random() > 0.5) b.splice(Math.floor(random() * (b.length + 1)), 0, 'x');
    const ops = diffWords(a, b);
    assert.deepEqual(ops.filter(o => o.op !== 'insert').map(o => a[o.a]), a);
    assert.deepEqual(ops.filter(o => o.op !== 'delete').map(o => b[o.b]), b);
    assert.ok(ops.filter(o => o.op === 'equal').every(o => a[o.a] === b[o.b]));
    assert.equal(ops.filter(o => o.op === 'equal').length, lcsLength(a, b));
  }
});

test('deleted words become cut ranges that span the pauses and spacing between them', () => {
  const words = tokens('Hola', null, 'a', '', 'todos.', 'Esto', 'sobra.', 'Fin.');
  const plan = planTranscriptEdit(words, parseEditedTranscript('Hola Esto Fin.'));
  assert.deepEqual(plan.cuts, [[2, 4], [6, 6]]);
  assert.deepEqual(plan.cutText, ['a todos.', 'sobra.']);
  assert.deepEqual(plan.corrections, []);
});

test('retyped, merged and inserted words correct captions instead of cutting', () => {
  const words = tokens('Lab', 'Bench', 'is', 'great.');
  assert.deepEqual(planTranscriptEdit(words, ['LabBench', 'is', 'great.']), {
    cuts: [], cutText: [], corrections: [{ start: 0, end: 1, from: 'Lab Bench', to: 'LabBench' }],
  });
  assert.deepEqual(planTranscriptEdit(words, ['Lab', 'Bench', 'is', 'really', 'great.']).corrections,
    [{ start: 2, end: 2, from: 'is', to: 'is really' }]);
  assert.deepEqual(planTranscriptEdit(words, ['So', 'Lab', 'Bench', 'is', 'great.']).corrections,
    [{ start: 0, end: 0, from: 'Lab', to: 'So Lab' }]);
  const plan = planTranscriptEdit(words, ['Lab', 'Bench', 'rocks.']);
  assert.deepEqual(plan.cuts, []);
  assert.deepEqual(plan.corrections, [{ start: 2, end: 3, from: 'is great.', to: 'rocks.' }]);
});

test('a deletion next to a retyped word cuts the deleted words and corrects the retyped ones', () => {
  const words = tokens('Hola.', 'Esto', 'sobra.', 'Lab', 'Bench', 'fin.');
  assert.deepEqual(planTranscriptEdit(words, ['Hola.', 'LabBench', 'fin.']), {
    cuts: [[1, 2]], cutText: ['Esto sobra.'], corrections: [{ start: 3, end: 4, from: 'Lab Bench', to: 'LabBench' }],
  });
  // Typed text that resembles none of the deleted words rewrites them all, and cuts nothing.
  assert.deepEqual(planTranscriptEdit(words, ['Hola.', 'Otra', 'cosa', 'fin.']).cuts, []);
});

test('multi-word segments are cut only when all their words are deleted', () => {
  const words = tokens('Hello there.', 'General Kenobi.');
  assert.deepEqual(planTranscriptEdit(words, ['General', 'Kenobi.']).cuts, [[0, 0]]);
  assert.deepEqual(planTranscriptEdit(words, ['Hello', 'General', 'Kenobi.']).corrections,
    [{ start: 0, end: 0, from: 'Hello there.', to: 'Hello' }]);
});

test('the editable text lists present words by paragraph and ignores comments when parsed', () => {
  const words = tokens('Uno', 'dos.', 'Tres');
  words[1].present = false;
  const text = renderEditableTranscript('Demo', words, [{ start: 0, end: 1 }, { start: 2, end: 2 }]);
  assert.match(text, /^# Screen Studio transcript: Demo/);
  assert.match(text, /^# ¶1 00:00\.0\nUno$/m);
  assert.deepEqual(parseEditedTranscript(text), ['Uno', 'Tres']);
});

test('token ranges and phrase search resolve to inclusive token indexes', () => {
  assert.deepEqual(parseRanges(['1', '3-5,7'], 10), [[1, 1], [3, 5], [7, 7]]);
  assert.throws(() => parseRanges(['5-3'], 10), /must not precede/);
  assert.throws(() => parseRanges(['11'], 10), /out of range/);
  const words = tokens('Hola,', 'a', 'todos.', 'Hola', 'otra', 'vez');
  assert.deepEqual(findPhrase(words, 'hola'), [[0, 0], [3, 3]]);
  assert.deepEqual(findPhrase(words, 'A TODOS'), [[1, 2]]);
});
