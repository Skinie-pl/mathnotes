'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../renderer/core.js');

test('formatTitle: bez nazwy pokazuje "Bez tytułu"', () => {
  assert.equal(core.formatTitle(null, false), 'Bez tytułu — MathNotes');
  assert.equal(core.formatTitle('', false), 'Bez tytułu — MathNotes');
  assert.equal(core.formatTitle('   ', false), 'Bez tytułu — MathNotes');
});

test('formatTitle: niezapisane zmiany oznacza kropka', () => {
  assert.equal(core.formatTitle('algebra', false), 'algebra — MathNotes');
  assert.equal(core.formatTitle('algebra', true), '• algebra — MathNotes');
  assert.equal(core.formatTitle(null, true), '• Bez tytułu — MathNotes');
});

test('MENU_ACTIONS: bez duplikatów, same stringi, zamrożone', () => {
  const actions = core.MENU_ACTIONS;
  assert.ok(Object.isFrozen(actions), 'lista akcji musi być zamrożona');
  assert.ok(actions.length > 0);
  assert.ok(
    actions.every((a) => typeof a === 'string' && a.includes(':')),
    'każda akcja to string w formacie "grupa:nazwa"',
  );
  assert.equal(new Set(actions).size, actions.length, 'duplikat akcji menu');
});
