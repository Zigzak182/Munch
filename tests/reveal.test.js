import test from 'node:test';
import assert from 'node:assert/strict';

import { shuffleSchedule } from '../src/reveal.js';

const NORMAL = { stepFrom: 65, stepTo: 300 };

test('the schedule spans roughly the requested duration', () => {
  const delays = shuffleSchedule(1700, NORMAL);
  const total = delays.reduce((sum, delay) => sum + delay, 0);

  assert.ok(total <= 1700, `overran: ${total}ms`);
  // Never leaves a gap longer than one final step at the end.
  assert.ok(total > 1700 - NORMAL.stepTo, `stopped short: ${total}ms`);
});

test('intervals only ever grow, so the shuffle decelerates', () => {
  const delays = shuffleSchedule(1700, NORMAL);

  assert.ok(delays.length > 3);
  assert.equal(delays[0], NORMAL.stepFrom);
  delays.forEach((delay, index) => {
    if (index > 0) assert.ok(delay >= delays[index - 1], `sped up at ${index}`);
    assert.ok(delay <= NORMAL.stepTo, `exceeded the cap: ${delay}`);
  });
  assert.ok(delays.at(-1) > delays[0] * 2, 'barely slowed down');
});

test('a zero starting step means no shuffle at all', () => {
  // The reduced-motion path: land almost immediately, no flicker.
  assert.deepEqual(shuffleSchedule(150, { stepFrom: 0, stepTo: 0 }), []);
});

test('a duration shorter than one step yields no ticks', () => {
  assert.deepEqual(shuffleSchedule(40, NORMAL), []);
});
