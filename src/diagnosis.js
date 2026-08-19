/**
 * Turns the quiz answers into a diagnosis: a headline, the cuisine, and the
 * search terms used to rank nearby venues.
 *
 * The matched dishes are deliberately *not* shown to the user. Naming a dish
 * above a list of venues implies those venues serve it, and nothing available
 * can confirm what is on a restaurant's current menu. They stay internal,
 * where they choose the cuisine and sharpen the venue search.
 *
 * Pure functions only — no DOM, no network — so this module is unit-testable
 * and safe to import from anywhere.
 */

import { COURSES, CUISINES, DISHES, DIAGNOSES, FLAVORS, SWEET, TEXTURES } from './data.js';

const WEIGHT_CUISINE = 4;
const WEIGHT_TEXTURE = 3;
const WEIGHT_FLAVOR = 3;

/** Look up an option object by id, or `null`. */
export function findOption(options, id) {
  return options.find((option) => option.id === id) ?? null;
}

/**
 * Bonus for matching a dish's *defining* trait — the first entry in its
 * `textures`/`flavors` list. Gyoza is soft before it is crispy, so a craving
 * for "crispy" should reach tonkatsu first even though both are tagged crispy.
 */
const WEIGHT_PRIMARY = 1;

/**
 * Score one dish against the answers.
 *
 * Cuisine is weighted highest because it is the only answer that also
 * constrains which venues we can realistically send someone to. Texture and
 * flavour score independently, so a near-miss still ranks above an unrelated
 * dish, and each pays a bonus when it matches the dish's leading tag.
 */
export function scoreDish(dish, { texture, flavor, cuisine }) {
  let score = 0;
  if (cuisine && dish.cuisine === cuisine) score += WEIGHT_CUISINE;

  if (texture && dish.textures.includes(texture)) {
    score += WEIGHT_TEXTURE + (dish.textures[0] === texture ? WEIGHT_PRIMARY : 0);
  }
  if (flavor && dish.flavors.includes(flavor)) {
    score += WEIGHT_FLAVOR + (dish.flavors[0] === flavor ? WEIGHT_PRIMARY : 0);
  }

  return score;
}

/** How many tags a dish claims. Fewer tags means a more specific match. */
const breadth = (dish) => dish.textures.length + dish.flavors.length;

/**
 * Which course an answer is asking for. Only `sweet` crosses over.
 *
 * The two catalogues never mix: asking for something sweet should not return
 * a curry house, and asking for something savoury should not return a
 * gelateria. Every ranking filters on this first.
 */
export function courseFor(flavor) {
  return flavor === SWEET ? 'dessert' : 'main';
}

/** A dish's course. Anything unlabelled is a main, which is most of them. */
const courseOf = (dish) => dish.course ?? 'main';

/** The dishes eligible for a given answer — one course, never both. */
export function dishesForCourse(flavor, dishes = DISHES) {
  const course = courseFor(flavor);
  return dishes.filter((dish) => courseOf(dish) === course);
}

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
  const scored = dishesForCourse(answers.flavor, dishes)
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
  const course = COURSES[courseFor(answers.flavor)];

  // On the dessert path the cuisine's own tags would drag in "ramen" and
  // "kebab", so the course supplies the backstop instead. The matched dishes'
  // terms still lead, which is what keeps a dessert search cuisine-flavoured.
  const backstop = course.terms ?? cuisine?.osmCuisines ?? [];

  const terms = [...matches.flatMap((dish) => dish.terms), ...backstop];
  return [...new Set(terms.map((term) => term.toLowerCase()))];
}

/** How many dishes of a cuisine contribute to its score. */
const CUISINE_DEPTH = 3;

/**
 * How many runner-up cuisines the results screen offers.
 *
 * The point of deriving a cuisine is to stop presenting a menu, so the escape
 * hatch stays short — the next best few, not everything that lost.
 */
const ALTERNATIVES = 3;

/**
 * How many dishes the venue-grounded suggestion may choose between.
 *
 * Wider than the three that shape the search, because the point is to find
 * what the neighbourhood actually supports — and the fourth-best fit for your
 * craving is a better answer than the best fit that nowhere nearby serves.
 */
const CANDIDATE_DEPTH = 6;

/**
 * Rank the cuisines themselves against a texture/flavour pair.
 *
 * The app asks two questions and decides the cuisine, so this is where that
 * decision is made. A cuisine is scored by the sum of its best few dishes
 * rather than by its single best: one perfect dish makes a lucky guess, while
 * three strong ones mean the whole kitchen is pointed at what you want — and
 * it also means the fallback dishes on the results screen are worth eating.
 *
 * @returns {{cuisine: object, score: number, dishes: object[]}[]} best first
 */
export function rankCuisines(answers, { dishes = DISHES } = {}) {
  const pair = { texture: answers.texture, flavor: answers.flavor };
  const eligible = dishesForCourse(answers.flavor, dishes);

  return CUISINES
    .map((cuisine) => {
      const ranked = eligible
        .filter((dish) => dish.cuisine === cuisine.id)
        .map((dish) => ({ dish, score: scoreDish(dish, pair) }))
        .sort((a, b) => b.score - a.score
          || breadth(a.dish) - breadth(b.dish)
          || a.dish.name.localeCompare(b.dish.name))
        .slice(0, CUISINE_DEPTH);

      return {
        cuisine,
        score: ranked.reduce((total, entry) => total + entry.score, 0),
        dishes: ranked.map((entry) => entry.dish),
      };
    })
    .sort((a, b) => b.score - a.score
      || breadth(a.dishes[0]) - breadth(b.dishes[0])
      || a.cuisine.label.localeCompare(b.cuisine.label));
}

/**
 * Build the full diagnosis object consumed by the results screen.
 *
 * The cuisine is derived from the two answers. `answers.cuisine` is honoured
 * when set — that is how the "try another" control and older three-part share
 * links pin a specific cuisine — and `alternatives` carries the rest of the
 * ranking so the UI can offer the runner-up when nothing is nearby.
 *
 * @param {{texture: string, flavor: string, cuisine?: string}} answers
 */
export function diagnose(answers) {
  const texture = findOption(TEXTURES, answers.texture);
  const flavor = findOption(FLAVORS, answers.flavor);

  const ranking = rankCuisines(answers);
  const pinned = ranking.find((entry) => entry.cuisine.id === answers.cuisine);
  const chosen = pinned ?? ranking[0];
  const cuisine = chosen.cuisine;

  const matches = rankDishes({ ...answers, cuisine: cuisine.id });
  const headline = [texture?.label, flavor?.label, cuisine.label]
    .filter(Boolean)
    .join(' · ');

  const courseId = courseFor(answers.flavor);
  const course = COURSES[courseId];

  return {
    texture,
    flavor,
    cuisine,
    course: courseId,
    /**
     * Venue type hints, already resolved for the course, so the caller does
     * not have to know that sweet means bakeries rather than restaurants.
     * Spread straight into `findNearbyPlaces`.
     */
    search: {
      googleTypes: course.googleTypes ?? cuisine.googleTypes,
      cuisineTags: course.osmCuisines ?? cuisine.osmCuisines,
      amenities: course.osmAmenities ?? undefined,
      shops: course.osmShops ?? [],
    },
    /** True when the cuisine was derived rather than pinned by the user. */
    derived: !pinned,
    alternatives: ranking
      .filter((entry) => entry.cuisine.id !== cuisine.id)
      .slice(0, ALTERNATIVES)
      .map((entry) => entry.cuisine),
    headline,
    verdict: DIAGNOSES[`${answers.texture}-${answers.flavor}`]
      ?? 'An unusual craving. We respect it.',
    /** Internal only — never rendered. See the module comment. */
    matches,
    /**
     * A wider slice of the same ranking, for suggest.js to test against the
     * venues that actually came back. Also never rendered on its own.
     */
    candidates: rankDishes({ ...answers, cuisine: cuisine.id }, { limit: CANDIDATE_DEPTH }),
    terms: searchTerms({ ...answers, cuisine: cuisine.id }, matches),
  };
}
