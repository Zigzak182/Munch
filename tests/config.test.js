import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheMinutes, fieldTier, googleApiKey, hasGoogle, mapId, photoLimit,
  providerPreference, showPhotos,
} from '../src/config.js';
import { FIELD_TIERS, fieldsFor } from '../src/providers/google.js';

/** Stand in for the deployment config that `munch.config.js` sets. */
function setConfig(values) {
  Object.defineProperty(globalThis, 'window', {
    value: values === null ? {} : { MUNCH_CONFIG: values },
    configurable: true,
    writable: true,
  });
}

test.afterEach(() => { delete globalThis.window; });

test('a missing config reads as no key, and never throws', () => {
  setConfig(null);

  assert.equal(googleApiKey(), '');
  assert.equal(hasGoogle(), false);
  assert.equal(mapId(), 'DEMO_MAP_ID');
});

test('the key is trimmed, and whitespace alone does not count as configured', () => {
  setConfig({ googleMapsApiKey: '  AIzaFake  ' });
  assert.equal(googleApiKey(), 'AIzaFake');
  assert.equal(hasGoogle(), true);

  setConfig({ googleMapsApiKey: '   ' });
  assert.equal(hasGoogle(), false);
});

test('an unset map id falls back to the demo style', () => {
  // Advanced markers need some map id, so an empty one cannot be passed through.
  setConfig({ mapId: '' });
  assert.equal(mapId(), 'DEMO_MAP_ID');

  setConfig({ mapId: ' abc123 ' });
  assert.equal(mapId(), 'abc123');
});

test('photos default to the top three cards', () => {
  setConfig({});
  assert.equal(showPhotos(), true);
  assert.equal(photoLimit(), 3);
});

test('the limit is configurable, and zero means none', () => {
  setConfig({ photoLimit: 8 });
  assert.equal(photoLimit(), 8);

  setConfig({ photoLimit: 0 });
  assert.equal(photoLimit(), 0);
});

test('showPhotos:false overrides any limit', () => {
  setConfig({ showPhotos: false, photoLimit: 20 });
  assert.equal(photoLimit(), 0);
});

test('a nonsense limit falls back to the default rather than showing none', () => {
  // Failing open on a typo is right here: the cost ceiling is still the
  // default, and a silently photo-less list would look broken.
  for (const value of ['lots', -4, Number.NaN, {}]) {
    setConfig({ photoLimit: value });
    assert.equal(photoLimit(), 3, `photoLimit: ${JSON.stringify(value)}`);
  }
});

test('a fractional limit floors rather than rendering half a card', () => {
  setConfig({ photoLimit: 2.7 });
  assert.equal(photoLimit(), 2);
});

// ------------------------------------------------------------- running cost

test('the field tier defaults to enterprise and rejects nonsense', () => {
  setConfig(null);
  assert.equal(fieldTier(), 'enterprise');

  for (const bad of ['deluxe', '', 42, null]) {
    setConfig({ fieldTier: bad });
    assert.equal(fieldTier(), 'enterprise', `${bad} should not select a tier`);
  }

  setConfig({ fieldTier: 'pro' });
  assert.equal(fieldTier(), 'pro');
});

test('the tiers are cumulative, cheapest first', () => {
  const { essentials, pro, enterprise } = FIELD_TIERS;

  assert.ok(essentials.every((field) => pro.includes(field)), 'pro must contain essentials');
  assert.ok(pro.every((field) => enterprise.includes(field)), 'enterprise must contain pro');
  assert.ok(essentials.length < pro.length && pro.length < enterprise.length);

  // The fields that force the Enterprise SKU must not appear below it.
  for (const dear of ['rating', 'userRatingCount', 'priceLevel', 'regularOpeningHours']) {
    assert.ok(enterprise.includes(dear));
    assert.ok(!pro.includes(dear), `${dear} would price a "pro" call as enterprise`);
  }

  // Enough to render a card at any tier: a name and somewhere to put it.
  for (const tier of Object.values(FIELD_TIERS)) {
    assert.ok(tier.includes('id') && tier.includes('displayName') && tier.includes('location'));
  }
});

test('fieldsFor follows the configured tier, and falls back safely', () => {
  setConfig({ fieldTier: 'essentials' });
  assert.deepEqual(fieldsFor(), FIELD_TIERS.essentials);

  setConfig({ fieldTier: 'nonsense' });
  assert.deepEqual(fieldsFor(), FIELD_TIERS.enterprise);

  assert.deepEqual(fieldsFor('pro'), FIELD_TIERS.pro);
});

test('the provider preference defaults to auto', () => {
  setConfig(null);
  assert.equal(providerPreference(), 'auto');

  setConfig({ provider: 'osm' });
  assert.equal(providerPreference(), 'osm');

  setConfig({ provider: 'carrier pigeon' });
  assert.equal(providerPreference(), 'auto');
});

test('cache minutes defaults to 30, and 0 is honoured as "off"', () => {
  setConfig(null);
  assert.equal(cacheMinutes(), 30);

  setConfig({ cacheMinutes: 0 });
  assert.equal(cacheMinutes(), 0, 'zero must disable rather than fall back');

  setConfig({ cacheMinutes: 5 });
  assert.equal(cacheMinutes(), 5);

  for (const bad of [-1, 'soon', Number.NaN]) {
    setConfig({ cacheMinutes: bad });
    assert.equal(cacheMinutes(), 30, `${bad} should fall back`);
  }
});
