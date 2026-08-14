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

const TIMING = {
  shuffleStep: 110,
  shuffle: 1150,
  hold: 1250,
};

const REDUCED = {
  shuffleStep: 0,
  shuffle: 150,
  hold: 450,
};

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

  return new Promise((resolve) => {
    const timers = [];
    let settled = false;

    const cleanup = () => {
      timers.forEach(clearTimeout);
      clearInterval(shuffleTimer);
      overlay.removeEventListener('click', skip);
      window.removeEventListener('keydown', skip);
    };

    /** Dismiss the overlay and resolve — safe to call more than once. */
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      overlay.classList.remove('is-open');
      // Wait out the fade so the results are not revealed mid-transition.
      setTimeout(() => {
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        resolve();
      }, prefersReducedMotion() ? 0 : 220);
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
      clearInterval(shuffleTimer);
      overlay.dataset.phase = 'landed';
      emoji.textContent = result.cuisine.emoji;
      caption.textContent = 'Your diagnosis';
      cuisineName.textContent = result.cuisine.label;
      dishName.textContent = result.matches[0]?.name ?? '';
    };

    // --- open -------------------------------------------------------------
    overlay.dataset.phase = 'thinking';
    overlay.hidden = false;
    overlay.setAttribute('aria-hidden', 'false');
    caption.textContent = 'Reading your craving…';
    cuisineName.textContent = '';
    dishName.textContent = '';
    emoji.textContent = SHUFFLE[0];

    // Force a reflow so the transition runs from the closed state.
    void overlay.offsetWidth;
    overlay.classList.add('is-open');

    let index = 0;
    const shuffleTimer = timing.shuffleStep > 0
      ? setInterval(() => {
        index = (index + 1) % SHUFFLE.length;
        emoji.textContent = SHUFFLE[index];
      }, timing.shuffleStep)
      : null;

    overlay.addEventListener('click', skip);
    window.addEventListener('keydown', skip);

    timers.push(setTimeout(land, timing.shuffle));
    timers.push(setTimeout(finish, timing.shuffle + timing.hold));
  });
}
