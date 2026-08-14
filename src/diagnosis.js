/**
 * Turns the three quiz answers into a diagnosis: a headline, the dishes that
 * best fit, and the search terms used to rank nearby venues.
 *
 * Pure functions only — no DOM, no network — so this module is unit-testable
 * and safe to import from anywhere.
 */

import { CUISINES, DISHES, DIAGNOSES, FLAVORS, TEXTURES } from './data.js';

const WEIGHT_CUISINE = 4;
const WEIGHT_TEXTURE = 3;
const WEIGHT_FLAVOR = 3;

/** Look up an option object by id, or `null`. */
export function findOption(options, id) {
  return options.find((option) => option.id === id) ?? null;
}

/**
 * Score one dish against the answers.
 *
 * Cuisine is weighted highest because it is the only answer that also
 * constrains which venues we can realistically send someone to. A dish scores
 * on texture and flavour independently, so a near-miss still ranks above an
 * unrelated dish.
 */
export function scoreDish(dish, { texture, flavor, cuisine }) {
  let score = 0;
  if (cuisine && dish.cuisine === cuisine) score += WEIGHT_CUISINE;
  if (texture && dish.textures.includes(texture)) score += WEIGHT_TEXTURE;
  if (flavor && dish.flavors.includes(flavor)) score += WEIGHT_FLAVOR;
  return score;
}

/** How many tags a dish claims. Fewer tags means a more specific match. */
const breadth = (dish) => dish.textures.length + dish.flavors.length;

/**
 * Rank every dish for the given answers.
 *
 * Dishes outside the chosen cuisine are dropped when the cuisine yields
 * enough candidates, so the results screen stays on-theme; if the cuisine is
 * thin on matches we fall back to the global ranking rather than showing an
 * empty list.
 *
 * Equal scores are broken by specificity: a dish tagged `saucy/spicy` is a
 * truer answer to "saucy and spicy" than one that also happens to be crispy
 * and savoury, since the latter scores the same from several directions.
 */
export function rankDishes(answers, { limit = 3, dishes = DISHES } = {}) {
  const scored = dishes
    .map((dish) => ({ dish, score: scoreDish(dish, answers) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score
      || breadth(a.dish) - breadth(b.dish)
      || a.dish.name.localeCompare(b.dish.name));

  const onCuisine = scored.filter((entry) => entry.dish.cuisine === answers.cuisine);
  const pool = onCuisine.length > 0 ? onCuisine : scored;
  return pool.slice(0, limit).map((entry) => entry.dish);
}

/**
 * Search terms used to rank venues, most specific first: the matched dishes'
 * own terms, then the cuisine's OSM tag values as a backstop.
 */
export function searchTerms(answers, matches) {
  const cuisine = findOption(CUISINES, answers.cuisine);
  const terms = [
    ...matches.flatMap((dish) => dish.terms),
    ...(cuisine?.osmCuisines ?? []),
  ];
  return [...new Set(terms.map((term) => term.toLowerCase()))];
}

/**
 * Build the full diagnosis object consumed by the results screen.
 *
 * @param {{texture: string, flavor: string, cuisine: string}} answers
 */
export function diagnose(answers) {
  const texture = findOption(TEXTURES, answers.texture);
  const flavor = findOption(FLAVORS, answers.flavor);
  const cuisine = findOption(CUISINES, answers.cuisine);
  const matches = rankDishes(answers);

  const headline = [texture?.label, flavor?.label, cuisine?.label]
    .filter(Boolean)
    .join(' · ');

  return {
    texture,
    flavor,
    cuisine,
    headline,
    verdict: DIAGNOSES[`${answers.texture}-${answers.flavor}`]
      ?? 'An unusual craving. We respect it.',
    matches,
    terms: searchTerms(answers, matches),
  };
}
