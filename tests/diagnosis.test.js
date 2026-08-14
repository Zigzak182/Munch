import test from 'node:test';
import assert from 'node:assert/strict';

import { CUISINES, DISHES, FLAVORS, TEXTURES } from '../src/data.js';
import { diagnose, rankCuisines, rankDishes, scoreDish, searchTerms } from '../src/diagnosis.js';

/** Every texture/flavour pair the quiz can produce. */
const PAIRS = TEXTURES.flatMap((texture) =>
  FLAVORS.map((flavor) => ({ texture: texture.id, flavor: flavor.id })));

test('every dish uses known texture, flavour and cuisine ids', () => {
  const textures = new Set(TEXTURES.map((option) => option.id));
  const flavors = new Set(FLAVORS.map((option) => option.id));
  const cuisines = new Set(CUISINES.map((option) => option.id));

  for (const dish of DISHES) {
    assert.ok(cuisines.has(dish.cuisine), `${dish.id} has unknown cuisine ${dish.cuisine}`);
    assert.ok(dish.textures.length > 0 && dish.flavors.length > 0, `${dish.id} has no tags`);
    dish.textures.forEach((t) => assert.ok(textures.has(t), `${dish.id} bad texture ${t}`));
    dish.flavors.forEach((f) => assert.ok(flavors.has(f), `${dish.id} bad flavour ${f}`));
    assert.ok(dish.terms.length > 0, `${dish.id} has no search terms`);
  }
});

test('dish ids are unique', () => {
  const ids = DISHES.map((dish) => dish.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('scoreDish rewards cuisine most, then each tag independently', () => {
  // textures: ['crispy', 'soft'], flavors: ['cheesy', 'savory'] — so 'crispy'
  // and 'cheesy' are its defining traits and earn the primary bonus.
  const dish = DISHES.find((entry) => entry.id === 'smash-burger');

  assert.equal(scoreDish(dish, { texture: 'crispy', flavor: 'cheesy', cuisine: 'american' }), 12);
  assert.equal(scoreDish(dish, { texture: 'soft', flavor: 'savory', cuisine: 'american' }), 10);
  assert.equal(scoreDish(dish, { texture: 'crispy', flavor: 'spicy', cuisine: 'american' }), 8);
  assert.equal(scoreDish(dish, { texture: 'saucy', flavor: 'spicy', cuisine: 'american' }), 4);
  assert.equal(scoreDish(dish, { texture: 'saucy', flavor: 'spicy', cuisine: 'japanese' }), 0);
});

test('a defining tag outranks the same tag listed second', () => {
  const tonkatsu = DISHES.find((entry) => entry.id === 'tonkatsu');   // crispy first
  const gyoza = DISHES.find((entry) => entry.id === 'gyoza');         // soft first, then crispy
  const answers = { texture: 'crispy', flavor: 'savory' };

  assert.ok(scoreDish(tonkatsu, answers) > scoreDish(gyoza, answers));
});

test('ranking keeps results inside the chosen cuisine', () => {
  const matches = rankDishes({ texture: 'saucy', flavor: 'spicy', cuisine: 'japanese' });

  assert.equal(matches.length, 3);
  assert.ok(matches.every((dish) => dish.cuisine === 'japanese'));
  assert.equal(matches[0].id, 'spicy-miso-ramen');
});

test('every combination of answers produces at least one dish', () => {
  for (const pair of PAIRS) {
    for (const cuisine of CUISINES) {
      const answers = { ...pair, cuisine: cuisine.id };
      const matches = rankDishes(answers);
      assert.ok(
        matches.length > 0,
        `no dish for ${pair.texture}/${pair.flavor}/${cuisine.id}`,
      );
      assert.ok(matches.every((dish) => dish.cuisine === cuisine.id));
    }
  }
});

test('rankCuisines returns every cuisine, best first, with dishes attached', () => {
  const ranking = rankCuisines({ texture: 'saucy', flavor: 'savory' });

  assert.equal(ranking.length, CUISINES.length);
  assert.equal(ranking[0].cuisine.id, 'japanese');
  assert.ok(ranking[0].dishes.length > 0);

  const scores = ranking.map((entry) => entry.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

test('the derived cuisine is decisive for every pair, and all four are reachable', () => {
  const picked = new Set();

  for (const pair of PAIRS) {
    const result = diagnose(pair);
    assert.ok(result.cuisine, `no cuisine derived for ${pair.texture}/${pair.flavor}`);
    assert.equal(result.derived, true);
    assert.equal(result.alternatives.length, CUISINES.length - 1);
    assert.ok(result.matches.every((dish) => dish.cuisine === result.cuisine.id));
    picked.add(result.cuisine.id);

    // Deciding twice must decide the same way.
    assert.equal(diagnose(pair).cuisine.id, result.cuisine.id);
  }

  assert.equal(picked.size, CUISINES.length, `only reached ${[...picked].join(', ')}`);
});

test('a pinned cuisine overrides the derived one and is not offered again', () => {
  const derived = diagnose({ texture: 'saucy', flavor: 'savory' });
  assert.equal(derived.cuisine.id, 'japanese');

  const pinned = diagnose({ texture: 'saucy', flavor: 'savory', cuisine: 'mexican' });
  assert.equal(pinned.cuisine.id, 'mexican');
  assert.equal(pinned.derived, false);
  assert.ok(pinned.matches.every((dish) => dish.cuisine === 'mexican'));
  assert.ok(!pinned.alternatives.some((cuisine) => cuisine.id === 'mexican'));
  assert.ok(pinned.alternatives.some((cuisine) => cuisine.id === 'japanese'));
});

test('an unknown pinned cuisine falls back to the derived one', () => {
  const result = diagnose({ texture: 'saucy', flavor: 'savory', cuisine: 'martian' });
  assert.equal(result.cuisine.id, 'japanese');
  assert.equal(result.derived, true);
});

test('search terms are de-duplicated and fall back to the cuisine tags', () => {
  const answers = { texture: 'crispy', flavor: 'cheesy', cuisine: 'american' };
  const terms = searchTerms(answers, rankDishes(answers));

  assert.equal(new Set(terms).size, terms.length);
  assert.ok(terms.includes('burger'));
  assert.ok(terms.every((term) => term === term.toLowerCase()));
});

test('diagnose returns a headline, verdict and matches for every combination', () => {
  for (const texture of TEXTURES) {
    for (const flavor of FLAVORS) {
      const result = diagnose({ texture: texture.id, flavor: flavor.id, cuisine: 'mexican' });

      assert.equal(result.headline, `${texture.label} · ${flavor.label} · Mexican`);
      assert.ok(result.verdict.length > 0);
      assert.ok(result.matches.length > 0);
      assert.ok(result.terms.length > 0);
      assert.equal(result.cuisine.id, 'mexican');
    }
  }
});

test('diagnose tolerates an unknown combination without throwing', () => {
  const result = diagnose({ texture: 'chewy', flavor: 'sour', cuisine: 'american' });
  assert.equal(result.verdict, 'An unusual craving. We respect it.');
  assert.ok(result.matches.length > 0);
});

test('every pair has a verdict written for it', () => {
  for (const pair of PAIRS) {
    assert.notEqual(
      diagnose(pair).verdict,
      'An unusual craving. We respect it.',
      `missing verdict copy for ${pair.texture}-${pair.flavor}`,
    );
  }
});
