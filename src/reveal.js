/**
 * The reveal: a short, full-screen moment between the last answer and the
 * results.
 *
 * The cuisine is decided for you, so the decision needs to be *seen* being
 * made — otherwise it reads as a label that was always there. This shuffles
 * through the cuisines, lands on one, and hands back control.
 *
 * It is skippable (tap or any key), honours `prefers-reduced-motion`, and
 * always resolves exactly once so the caller can await it.
 */

import { CUISINES } from './data.js';

/** Emoji cycled during the "thinking" phase. */
const SHUFFLE = CUISINES.map((cuisine) => cuisine.emoji);

/**
 * Roughly 4.6s end to end: long enough to read the cuisine, short enough to
 * sit through more than once. The hold carries most of it — the landing is
 * the part worth seeing, not the shuffle.
 */
const TIMING = {
  shuffle: 1700,
  hold: 2600,
  /** Shuffle interval at the start and end — it decelerates between them. */
  stepFrom: 65,
  stepTo: 300,
};

const REDUCED = {
  shuffle: 150,
  hold: 450,
  stepFrom: 0,
  stepTo: 0,
};

/** Confetti thrown when the cuisine lands. */
const CONFETTI = 18;

/**
 * Interval schedule for the shuffle, easing from `stepFrom` to `stepTo` so it
 * slows into the answer like a wheel coming to rest. Returns the delay before
 * each emoji change, together spanning roughly `duration`.
 */
export function shuffleSchedule(duration, { stepFrom, stepTo }) {
  if (stepFrom <= 0) return [];

  const delays = [];
  let elapsed = 0;
  let delay = stepFrom;

  while (elapsed + delay < duration) {
    delays.push(delay);
    elapsed += delay;
    delay = Math.min(stepTo, delay * 1.16);
  }

  return delays;
}

const $ = (id) => document.getElementById(id);

const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Play the reveal for a diagnosis.
 *
 * @param {{cuisine: object, matches: object[]}} result
 * @returns {Promise<void>} resolves once the overlay is fully dismissed
 */
export function playReveal(result) {
  const overlay = $('reveal');
  if (!overlay) return Promise.resolve();

  const timing = prefersReducedMotion() ? REDUCED : TIMING;
  const emoji = $('reveal-emoji');
  const caption = $('reveal-caption');
  const cuisineName = $('reveal-cuisine');
  const dishName = $('reveal-dish');
  const burst = $('reveal-burst');

  return new Promise((resolve) => {
    /** Shuffle ticks and the landing, all cleared when the reveal lands. */
    const timers = [];
    /** Kept apart from `timers` so landing does not cancel the dismissal. */
    let holdTimer = null;
    let settled = false;

    const cleanup = () => {
      timers.forEach(clearTimeout);
      clearTimeout(holdTimer);
      overlay.removeEventListener('click', skip);
      window.removeEventListener('keydown', skip);
    };

    /** Scatter dots outward from the emoji. Pure CSS once created. */
    const throwConfetti = () => {
      if (!burst) return;
      burst.innerHTML = '';

      for (let i = 0; i < CONFETTI; i += 1) {
        const angle = (i / CONFETTI) * Math.PI * 2 + Math.random() * 0.4;
        const distance = 115 + Math.random() * 105;
        const piece = document.createElement('span');
        piece.className = 'confetti';
        piece.style.setProperty('--x', `${Math.cos(angle) * distance}px`);
        piece.style.setProperty('--y', `${Math.sin(angle) * distance}px`);
        piece.style.setProperty('--spin', `${Math.round(Math.random() * 540 - 270)}deg`);
        piece.style.setProperty('--delay', `${Math.round(Math.random() * 120)}ms`);
        piece.style.setProperty('--size', `${6 + Math.round(Math.random() * 5)}px`);
        if (i % 3 === 0) piece.classList.add('confetti--alt');
        burst.append(piece);
      }
    };

    /** Dismiss the overlay and resolve — safe to call more than once. */
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      overlay.classList.remove('is-open');
      // Wait out the fade so the results are not revealed mid-transition.
      // Must stay in step with the `.reveal` opacity transition in the CSS.
      setTimeout(() => {
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        resolve();
      }, prefersReducedMotion() ? 0 : 320);
    };

    /** Jump straight to the landed state, then finish shortly after. */
    const skip = () => {
      if (settled || overlay.dataset.phase === 'landed') {
        finish();
        return;
      }
      land();
      timers.push(setTimeout(finish, 400));
    };

    const land = () => {
      timers.forEach(clearTimeout);
      timers.length = 0;
      overlay.dataset.phase = 'landed';
      emoji.textContent = result.cuisine.emoji;
      caption.textContent = 'Your diagnosis';
      cuisineName.textContent = result.cuisine.label;
      dishName.textContent = result.matches[0]?.name ?? '';
      if (!prefersReducedMotion()) throwConfetti();
    };

    // --- open -------------------------------------------------------------
    overlay.dataset.phase = 'thinking';
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    caption.textContent = 'Reading your craving…';
    cuisineName.textContent = '';
    dishName.textContent = '';
    emoji.textContent = SHUFFLE[0];
    if (burst) burst.innerHTML = '';

    // Force a reflow so the transition runs from the closed state.
    void overlay.offsetWidth;
    overlay.classList.add('is-open');

    // Each tick is scheduled at its own delay so the shuffle can decelerate.
    let index = 0;
    let elapsed = 0;
    shuffleSchedule(timing.shuffle, timing).forEach((delay) => {
      elapsed += delay;
      timers.push(setTimeout(() => {
        index = (index + 1) % SHUFFLE.length;
        emoji.textContent = SHUFFLE[index];
      }, elapsed));
    });

    overlay.addEventListener('click', skip);
    window.addEventListener('keydown', skip);

    timers.push(setTimeout(land, timing.shuffle));
    holdTimer = setTimeout(finish, timing.shuffle + timing.hold);
  });
}
