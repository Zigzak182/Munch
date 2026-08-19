import test from 'node:test';
import assert from 'node:assert/strict';

import { COURSES } from '../../src/data.js';
import { DEFAULT_TIER, TIERS, allowsCourse, describeTier, tierFor } from '../src/tiers.js';

test('free cannot reach desserts, plus can', () => {
  assert.equal(allowsCourse('free', 'main'), true);
  assert.equal(allowsCourse('free', 'dessert'), false);
  assert.equal(allowsCourse('plus', 'main'), true);
  assert.equal(allowsCourse('plus', 'dessert'), true);
});

test('an unknown or missing tier is treated as free', () => {
  // Anything that is not positively recognised must land on the cheapest
  // tier — a typo in a claim must never open the paywall.
  for (const bad of ['premium', 'PLUS', '', null, undefined, 'admin']) {
    assert.equal(tierFor(bad).id, DEFAULT_TIER, `${bad} should be free`);
    assert.equal(allowsCourse(bad, 'dessert'), false);
  }
});

test('every course the app defines is covered by some tier', () => {
  const covered = new Set(Object.values(TIERS).flatMap((tier) => tier.courses));
  for (const course of Object.keys(COURSES)) {
    assert.ok(covered.has(course), `no tier grants ${course}`);
  }
});

test('plus is never stingier than free', () => {
  assert.ok(TIERS.plus.searchesPerHour >= TIERS.free.searchesPerHour);
  assert.ok(TIERS.plus.photosPerHour >= TIERS.free.photosPerHour);
  assert.ok(TIERS.free.courses.every((course) => TIERS.plus.courses.includes(course)));
});

test('the client is told what it has, so it need not guess', () => {
  const free = describeTier('free');

  assert.equal(free.tier, 'free');
  assert.deepEqual(free.courses, ['main']);
  assert.ok(free.limits.searchesPerHour > 0);
  // A copy, so a caller cannot mutate the tier table through it.
  free.courses.push('dessert');
  assert.deepEqual(describeTier('free').courses, ['main']);
});
