import test from 'node:test';
import assert from 'node:assert/strict';

import { COURSES, CUISINES, DISHES, FLAVORS, SWEET, TEXTURES } from '../src/data.js';
import {
  courseFor, diagnose, dishesForCourse, rankCuisines, rankDishes, scoreDish, searchTerms,
} from '../src/diagnosis.js';

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
  assert.equal(scoreDish(dish, { texture: 'saucy', flavor: 'spicy', cuisine: 'asian' }), 0);
});

test('a defining tag outranks the same tag listed second', () => {
  const tonkatsu = DISHES.find((entry) => entry.id === 'tonkatsu');   // crispy first
  const gyoza = DISHES.find((entry) => entry.id === 'gyoza');         // soft first, then crispy
  const answers = { texture: 'crispy', flavor: 'savory' };

  assert.ok(scoreDish(tonkatsu, answers) > scoreDish(gyoza, answers));
});

test('ranking keeps results inside the chosen cuisine', () => {
  const matches = rankDishes({ texture: 'saucy', flavor: 'spicy', cuisine: 'asian' });

  assert.equal(matches.length, 3);
  assert.ok(matches.every((dish) => dish.cuisine === 'asian'));
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
  assert.ok(ranking[0].dishes.length > 0);
  assert.ok(ranking.every((entry) => entry.dishes.length > 0));

  const scores = ranking.map((entry) => entry.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
});

/** Dessert has no cuisine, so cuisine-derivation only applies to the rest. */
const MAIN_PAIRS = PAIRS.filter((pair) => pair.flavor !== SWEET);

test('the derived cuisine is decisive for every main pair, and every cuisine is reachable', () => {
  const picked = new Set();

  for (const pair of MAIN_PAIRS) {
    const result = diagnose(pair);
    assert.ok(result.cuisine, `no cuisine derived for ${pair.texture}/${pair.flavor}`);
    assert.equal(result.derived, true);
    assert.ok(result.alternatives.length > 0);
    assert.ok(result.matches.every((dish) => dish.cuisine === result.cuisine.id));
    picked.add(result.cuisine.id);

    // Deciding twice must decide the same way.
    assert.equal(diagnose(pair).cuisine.id, result.cuisine.id);
  }

  assert.equal(picked.size, CUISINES.length, `only reached ${[...picked].join(', ')}`);
});

test('a pinned cuisine overrides the derived one and is not offered again', () => {
  const derived = diagnose({ texture: 'saucy', flavor: 'savory' });
  assert.notEqual(derived.cuisine.id, 'mexican');

  const pinned = diagnose({ texture: 'saucy', flavor: 'savory', cuisine: 'mexican' });
  assert.equal(pinned.cuisine.id, 'mexican');
  assert.equal(pinned.derived, false);
  assert.ok(pinned.matches.every((dish) => dish.cuisine === 'mexican'));
  assert.ok(!pinned.alternatives.some((cuisine) => cuisine.id === 'mexican'));
  assert.ok(pinned.alternatives.some((cuisine) => cuisine.id === derived.cuisine.id));
});

test('an unknown pinned cuisine falls back to the derived one', () => {
  // Also covers share links made before the cuisine list changed, which
  // carry an id that no longer exists.
  const derived = diagnose({ texture: 'saucy', flavor: 'savory' });
  const stale = diagnose({ texture: 'saucy', flavor: 'savory', cuisine: 'japanese' });

  assert.equal(stale.cuisine.id, derived.cuisine.id);
  assert.equal(stale.derived, true);
  assert.equal(diagnose({ texture: 'saucy', flavor: 'savory', cuisine: 'martian' }).derived, true);
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

      assert.ok(result.verdict.length > 0);
      assert.ok(result.matches.length > 0);
      assert.ok(result.terms.length > 0);

      if (flavor.id === SWEET) {
        // The pinned cuisine is ignored, and the headline says so by omission.
        assert.equal(result.headline, `${texture.label} · ${flavor.label}`);
        assert.equal(result.cuisine, null);
      } else {
        assert.equal(result.headline, `${texture.label} · ${flavor.label} · Mexican`);
        assert.equal(result.cuisine.id, 'mexican');
      }
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

// ------------------------------------------------------------- the sweet path

const DESSERTS = DISHES.filter((dish) => dish.course === 'dessert');
const SWEET_PAIRS = TEXTURES.map((texture) => ({ texture: texture.id, flavor: SWEET }));

test('sweet is the only flavour that changes the course', () => {
  assert.equal(courseFor(SWEET), 'dessert');
  for (const flavor of FLAVORS.filter((entry) => entry.id !== SWEET)) {
    assert.equal(courseFor(flavor.id), 'main', `${flavor.id} should stay a main`);
  }
});

test('the two catalogues never mix', () => {
  // A savoury craving must not reach a gelateria, and a sweet one must not
  // reach a curry house — so neither ranking may see the other's dishes.
  assert.ok(DESSERTS.length > 0);
  assert.ok(dishesForCourse(SWEET).every((dish) => dish.course === 'dessert'));
  assert.ok(dishesForCourse('savory').every((dish) => dish.course !== 'dessert'));

  for (const pair of PAIRS) {
    const isSweet = pair.flavor === SWEET;
    const matches = diagnose(pair).matches;
    assert.ok(
      matches.every((dish) => (dish.course === 'dessert') === isSweet),
      `${pair.texture}/${pair.flavor} mixed courses`,
    );
  }
});

test('every dessert is tagged sweet, and only desserts are', () => {
  for (const dish of DESSERTS) {
    assert.ok(dish.flavors.includes(SWEET), `${dish.id} is a dessert but not sweet`);
  }
  for (const dish of DISHES.filter((entry) => entry.course !== 'dessert')) {
    assert.ok(!dish.flavors.includes(SWEET), `${dish.id} is sweet but not a dessert`);
  }
});

test('the dessert catalogue is level across cuisines and covers every texture', () => {
  // Scores sum a cuisine's best three, so a cuisine with more desserts would
  // win the sweet pairs on depth alone. Same rule as the main catalogue.
  const counts = CUISINES.map((cuisine) =>
    DESSERTS.filter((dish) => dish.cuisine === cuisine.id).length);

  assert.equal(new Set(counts).size, 1, `uneven dessert depth: ${counts.join(', ')}`);
  assert.ok(counts[0] >= TEXTURES.length);

  for (const cuisine of CUISINES) {
    const leading = new Set(
      DESSERTS.filter((dish) => dish.cuisine === cuisine.id).map((dish) => dish.textures[0]),
    );
    assert.deepEqual(
      [...leading].sort(),
      TEXTURES.map((texture) => texture.id).sort(),
      `${cuisine.id} desserts do not lead on every texture`,
    );
  }
});

test('dessert is a course, not a cuisine — so it never names one', () => {
  for (const pair of SWEET_PAIRS) {
    const result = diagnose(pair);

    assert.equal(result.cuisine, null, `${pair.texture}/sweet named a cuisine`);
    assert.deepEqual(result.alternatives, [], 'there is no cuisine to offer alternatives to');
    assert.equal(result.headline, `${result.texture.label} · Sweet`);
    assert.equal(result.search.cuisine, undefined, 'no cuisine is sent to the backend');
    assert.ok(result.search.googleTypes.includes('bakery'), 'the course supplies its own types');
  }
});

test('a cuisine pinned in a shared link is ignored on the dessert path', () => {
  // `#crispy/sweet/mexican` must not reintroduce what the course removed.
  const pinned = diagnose({ texture: 'crispy', flavor: SWEET, cuisine: 'mexican' });
  const plain = diagnose({ texture: 'crispy', flavor: SWEET });

  assert.equal(pinned.cuisine, null);
  assert.equal(pinned.headline, plain.headline);
  assert.deepEqual(pinned.candidates.map((dish) => dish.id), plain.candidates.map((dish) => dish.id));
});

test('dessert candidates are drawn from the whole catalogue, not one kitchen', () => {
  // The reason for dropping the cuisine: crispy and sweet should be able to
  // reach the Greek bakery's loukoumades, not only the Mexican churros.
  for (const pair of SWEET_PAIRS) {
    const cuisines = new Set(diagnose(pair).candidates.map((dish) => dish.cuisine));
    assert.ok(cuisines.size > 1,
      `${pair.texture}/sweet only considered ${[...cuisines].join(', ')}`);
  }
});

test('every dessert candidate still matches the texture that was asked for', () => {
  // Widening the field must not turn it into "any dessert at all".
  for (const pair of SWEET_PAIRS) {
    const top = diagnose(pair).candidates[0];
    assert.ok(top.textures.includes(pair.texture),
      `${top.name} does not satisfy ${pair.texture}`);
  }
});

test('a dessert search looks for bakeries, not restaurants', () => {
  const sweet = diagnose({ texture: 'crispy', flavor: SWEET });
  const savoury = diagnose({ texture: 'crispy', flavor: 'savory' });

  assert.equal(sweet.course, 'dessert');
  assert.deepEqual(sweet.search.googleTypes, COURSES.dessert.googleTypes);
  assert.ok(sweet.search.googleTypes.includes('bakery'));
  assert.ok(sweet.search.shops.includes('bakery'));
  assert.ok(!sweet.search.googleTypes.some((type) => type.endsWith('_restaurant')));

  // The savoury path is untouched: still the cuisine's own restaurant types.
  assert.equal(savoury.course, 'main');
  assert.deepEqual(savoury.search.googleTypes, savoury.cuisine.googleTypes);
  assert.deepEqual(savoury.search.shops, []);
  assert.equal(savoury.search.amenities, undefined);
});

test('dessert search terms stay sweet and still carry the cuisine', () => {
  const answers = { texture: 'crispy', flavor: SWEET, cuisine: 'mexican' };
  const terms = searchTerms(answers, rankDishes(answers));

  // The dish terms lead, which is what keeps it Mexican rather than generic.
  assert.ok(terms.includes('churro'));
  // ...and the cuisine's savoury tags must not ride along.
  for (const savoury of ['taco', 'burrito', 'tex-mex']) {
    assert.ok(!terms.includes(savoury), `"${savoury}" leaked into a dessert search`);
  }
  assert.ok(terms.includes('bakery'));
});

test('nothing user-facing in a diagnosis names a dish', () => {
  // The dish catalogue is scoring data. If a dish name ever reaches the
  // headline or verdict, the screen starts implying that nearby venues serve
  // it — which nothing can confirm.
  const names = DISHES.map((dish) => dish.name.toLowerCase());

  for (const pair of PAIRS) {
    const result = diagnose(pair);
    const visible = `${result.headline} ${result.verdict}`.toLowerCase();

    for (const name of names) {
      assert.ok(
        !visible.includes(name),
        `"${name}" leaked into user-facing copy for ${pair.texture}/${pair.flavor}`,
      );
    }
  }
});
