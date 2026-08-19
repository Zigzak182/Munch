import test from 'node:test';
import assert from 'node:assert/strict';

import { CUISINES, DISHES } from '../src/data.js';
import { diagnose, findOption } from '../src/diagnosis.js';
import {
  describeSuggestion, evidenceTerms, placeSupports, suggestDish,
} from '../src/suggest.js';

const dish = (id) => DISHES.find((entry) => entry.id === id);
const mexican = findOption(CUISINES, 'mexican');
const asian = findOption(CUISINES, 'asian');

const place = (name, { types = [], typeLabel = '' } = {}) => ({ name, types, typeLabel });

test('the cuisine\'s own words are not evidence', () => {
  // Every venue in a Mexican search is Mexican, so "mexican" separates
  // nothing — if it counted, every candidate would tie on every search.
  const terms = evidenceTerms(dish('birria'), mexican);

  assert.ok(terms.includes('birria'));
  assert.ok(!terms.includes('mexican'), 'the cuisine id must not count');
  assert.ok(!terms.includes('taco'), 'a cuisine-level tag must not count');
});

test('words that describe a venue rather than a dish are not evidence', () => {
  const terms = evidenceTerms(dish('churros'), mexican);

  assert.ok(terms.includes('churro'));
  assert.ok(terms.includes('churreria'));
  // "panaderia" survives: it names a specific kind of place, unlike "bakery",
  // which describes every venue in a dessert search.
  assert.ok(terms.includes('panaderia'));
  assert.ok(!terms.some((term) => ['restaurant', 'bakery', 'cafe'].includes(term)));
});

test('a venue supports a dish by name or by type', () => {
  const terms = ['ramen'];

  assert.ok(placeSupports(place('Ramen Kid'), terms));
  assert.ok(placeSupports(place('Noodle Bar', { types: ['ramen_restaurant'] }), terms));
  assert.ok(placeSupports(place('Noodle Bar', { typeLabel: 'Ramen restaurant' }), terms));
  assert.ok(!placeSupports(place('Pizza Express', { types: ['pizza_restaurant'] }), terms));
  assert.ok(!placeSupports(place('Ramen Kid'), []), 'no terms cannot match');
});

test('nothing is suggested when nothing points anywhere', () => {
  // The honest case, and the one that must never invent a dish: generic
  // venues that happen to be the right cuisine.
  const places = [
    place('Casa Verde', { types: ['mexican_restaurant'] }),
    place('El Sol', { types: ['mexican_restaurant'] }),
  ];

  assert.equal(suggestDish(diagnose({ texture: 'saucy', flavor: 'spicy' }).candidates, places,
    { cuisine: mexican }), null);
});

test('nothing is suggested with no venues at all', () => {
  const { candidates } = diagnose({ texture: 'saucy', flavor: 'spicy' });
  assert.equal(suggestDish(candidates, [], { cuisine: mexican }), null);
  assert.equal(suggestDish(candidates, null, { cuisine: mexican }), null);
});

test('many venues pointing one way reads as strong', () => {
  const places = [
    place('Birria King'), place('Birria y Mas'), place('La Birria'),
    place('Taqueria Sol'), place('Casa Verde'),
  ];

  const result = suggestDish(
    diagnose({ texture: 'saucy', flavor: 'savory', cuisine: 'mexican' }).candidates,
    places,
    { cuisine: mexican },
  );

  assert.equal(result.dish.id, 'birria');
  assert.equal(result.venues, 3);
  assert.equal(result.confidence, 'strong');
});

test('one venue pointing one way reads as a guess', () => {
  const places = [
    place('Birria King'),
    place('Casa Verde'), place('El Sol'), place('La Cocina'), place('Mi Tierra'),
  ];

  const result = suggestDish(
    diagnose({ texture: 'saucy', flavor: 'savory', cuisine: 'mexican' }).candidates,
    places,
    { cuisine: mexican },
  );

  assert.equal(result.venues, 1);
  assert.equal(result.confidence, 'possible');
});

test('a few hits in a big list is noise, not a pattern', () => {
  // Three supporting venues clears the count, but not out of thirty.
  const places = [
    place('Birria King'), place('Birria y Mas'), place('La Birria'),
    ...Array.from({ length: 27 }, (_, i) => place(`Generic Cantina ${i}`)),
  ];

  const result = suggestDish(
    diagnose({ texture: 'saucy', flavor: 'savory', cuisine: 'mexican' }).candidates,
    places,
    { cuisine: mexican },
  );

  assert.equal(result.venues, 3);
  assert.equal(result.confidence, 'possible', 'three in thirty should not lead');
});

test('the dish with more venues behind it wins', () => {
  const places = [
    place('Gyoza Bar'),
    place('Katsu House'), place('Tonkatsu Ya'), place('Katsu Curry Co'),
  ];

  const result = suggestDish(
    diagnose({ texture: 'crispy', flavor: 'savory', cuisine: 'asian' }).candidates,
    places,
    { cuisine: asian },
  );

  assert.equal(result.dish.id, 'tonkatsu');
  assert.equal(result.venues, 3);
});

test('the wording suggests and never states availability', () => {
  const strong = describeSuggestion({ dish: dish('birria'), venues: 6, confidence: 'strong' });
  const weak = describeSuggestion({ dish: dish('birria'), venues: 1, confidence: 'possible' });

  for (const { lead, note } of [strong, weak]) {
    const copy = `${lead} ${note}`.toLowerCase();

    // Nothing here may assert that a venue has the dish, or that it is ready
    // to be ordered right now.
    for (const claim of ['serves', 'available', 'order the', 'on the menu', 'in stock']) {
      assert.ok(!copy.includes(claim), `"${claim}" claims more than we know: ${copy}`);
    }
    assert.ok(lead.includes('Birria'), 'the dish should still be named');
  }

  assert.match(strong.note, /hunch|can't read menus/i);
  assert.match(weak.note, /guess|check the menu/i);
  assert.match(weak.lead, /^Maybe/);
});

test('one venue is singular, several are plural', () => {
  assert.match(
    describeSuggestion({ dish: dish('churros'), venues: 1, confidence: 'possible' }).note,
    /1 place\b/,
  );
  assert.match(
    describeSuggestion({ dish: dish('churros'), venues: 4, confidence: 'strong' }).note,
    /4 places\b/,
  );
});

test('candidates are wider than the dishes that shape the search', () => {
  const result = diagnose({ texture: 'crispy', flavor: 'savory' });

  assert.ok(result.candidates.length > result.matches.length);
  assert.ok(result.candidates.every((entry) => entry.cuisine === result.cuisine.id));
  // The first candidates are the matches — same ranking, just deeper.
  assert.deepEqual(
    result.candidates.slice(0, result.matches.length).map((entry) => entry.id),
    result.matches.map((entry) => entry.id),
  );
});

test('a dessert suggestion is grounded the same way', () => {
  const places = [
    place('Churreria Madrid'), place('Churros & Co'), place('Panaderia Luz'),
    place('Dulce Bakery', { types: ['bakery'] }),
  ];

  const result = suggestDish(
    diagnose({ texture: 'crispy', flavor: 'sweet' }).candidates,
    places,
    { cuisine: mexican },
  );

  // A panaderia counts — it is a specific kind of place that plausibly has
  // churros. A shop merely typed `bakery` does not: that word describes every
  // venue in a dessert search and so separates nothing.
  assert.equal(result.dish.id, 'churros');
  assert.equal(result.venues, 3);
  assert.ok(!places.slice(3).some((entry) => entry.name.includes('Churr')));
});
