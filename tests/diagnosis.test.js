import test from 'node:test';
import assert from 'node:assert/strict';

import { CUISINES, DISHES, FLAVORS, TEXTURES } from '../src/data.js';
import { diagnose, rankDishes, scoreDish, searchTerms } from '../src/diagnosis.js';

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
  const dish = DISHES.find((entry) => entry.id === 'smash-burger');

  assert.equal(scoreDish(dish, { texture: 'crispy', flavor: 'cheesy', cuisine: 'american' }), 10);
  assert.equal(scoreDish(dish, { texture: 'crispy', flavor: 'spicy', cuisine: 'american' }), 7);
  assert.equal(scoreDish(dish, { texture: 'saucy', flavor: 'spicy', cuisine: 'american' }), 4);
  assert.equal(scoreDish(dish, { texture: 'saucy', flavor: 'spicy', cuisine: 'japanese' }), 0);
});

test('ranking keeps results inside the chosen cuisine', () => {
  const matches = rankDishes({ texture: 'saucy', flavor: 'spicy', cuisine: 'japanese' });

  assert.equal(matches.length, 3);
  assert.ok(matches.every((dish) => dish.cuisine === 'japanese'));
  assert.equal(matches[0].id, 'spicy-miso-ramen');
});

test('every combination of answers produces at least one dish', () => {
  for (const texture of TEXTURES) {
    for (const flavor of FLAVORS) {
      for (const cuisine of CUISINES) {
        const answers = { texture: texture.id, flavor: flavor.id, cuisine: cuisine.id };
        const matches = rankDishes(answers);
        assert.ok(
          matches.length > 0,
          `no dish for ${texture.id}/${flavor.id}/${cuisine.id}`,
        );
        assert.ok(matches.every((dish) => dish.cuisine === cuisine.id));
      }
    }
  }
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
