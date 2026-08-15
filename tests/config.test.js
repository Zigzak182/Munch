import test from 'node:test';
import assert from 'node:assert/strict';

import { googleApiKey, hasGoogle, mapId, photoLimit, showPhotos } from '../src/config.js';

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
