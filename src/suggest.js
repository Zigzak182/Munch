/**
 * Guessing what to actually order, from the venues we found.
 *
 * The rest of the app deliberately never names a dish: printing one above a
 * list of venues implies those venues serve it, and no API can confirm what is
 * on a restaurant's current menu.
 *
 * This is the one exception, and it earns it by working the other way round.
 * Rather than naming a dish and hoping, it reads the venues that actually came
 * back and asks which candidate dish they point at. Six ramen shops nearby are
 * real evidence about ramen. One venue whose name happens to contain "taco" is
 * a hunch. The strength of the wording follows the strength of the evidence,
 * and where there is no evidence it says nothing at all.
 *
 * It still never claims availability — see `describeSuggestion`.
 */

/**
 * Terms that cannot be evidence.
 *
 * The venue list was already filtered by cuisine, so "mexican" matching every
 * Mexican restaurant tells us nothing about which dish to expect — every
 * candidate would score identically. The same goes for words that describe the
 * venue rather than the food.
 */
const GENERIC_TERMS = new Set([
  'restaurant', 'cafe', 'coffee', 'diner', 'takeaway', 'food', 'bakery',
  'dessert', 'desserts', 'sweets', 'pastry', 'patisserie', 'bar', 'pub',
  'grill', 'kitchen', 'house',
]);

/** The terms of a dish that carry real information about *this* venue list. */
export function evidenceTerms(dish, cuisine) {
  const excluded = new Set([
    cuisine?.id?.toLowerCase(),
    cuisine?.label?.toLowerCase(),
    ...(cuisine?.osmCuisines ?? []).map((term) => term.toLowerCase()),
  ]);

  return dish.terms
    .map((term) => term.toLowerCase())
    .filter((term) => !GENERIC_TERMS.has(term) && !excluded.has(term));
}

/** Everything about a place that could name a dish. */
function haystack(place) {
  return [place.name, place.typeLabel, ...(place.types ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** Does this venue point at this dish? */
export function placeSupports(place, terms) {
  if (terms.length === 0) return false;
  const text = haystack(place);
  return terms.some((term) => text.includes(term));
}

/**
 * Strong enough to lead with, rather than to hedge twice over.
 *
 * Both conditions matter: three venues out of four is a pattern, three out of
 * forty is noise that happens to clear a threshold.
 */
const STRONG_MIN_VENUES = 3;
const STRONG_MIN_SHARE = 0.3;

/**
 * The dish the venues most point at, or null when they point nowhere.
 *
 * Candidates arrive already ranked by how well they fit the craving, so an
 * equal amount of evidence keeps the better-fitting dish.
 *
 * @param {object[]} candidates dishes, best craving-fit first
 * @param {object[]} places the venues actually found
 * @returns {{dish: object, venues: number, share: number, confidence: 'strong'|'possible'}|null}
 */
export function suggestDish(candidates, places, { cuisine } = {}) {
  if (!Array.isArray(candidates) || !Array.isArray(places) || places.length === 0) return null;

  let best = null;

  candidates.forEach((dish, index) => {
    const terms = evidenceTerms(dish, cuisine);
    const venues = places.filter((place) => placeSupports(place, terms)).length;
    if (venues === 0) return;

    // Ties go to the dish that better matched the craving, which is the order
    // candidates arrived in.
    if (!best || venues > best.venues) best = { dish, venues, index };
  });

  if (!best) return null;

  const share = best.venues / places.length;
  return {
    dish: best.dish,
    venues: best.venues,
    share,
    confidence: best.venues >= STRONG_MIN_VENUES && share >= STRONG_MIN_SHARE
      ? 'strong'
      : 'possible',
  };
}

/**
 * Wording for a suggestion.
 *
 * Every phrasing here is a prediction about what a place is *likely* to serve,
 * never a statement that it does. Menus are not published anywhere we can
 * read, so the copy says so rather than letting the reader assume otherwise.
 *
 * @returns {{lead: string, note: string}}
 */
export function describeSuggestion({ dish, venues, confidence }) {
  const places = `${venues} ${venues === 1 ? 'place' : 'places'}`;

  if (confidence === 'strong') {
    return {
      lead: `Good odds on ${dish.name}`,
      note: `${places} below point that way. We can't read menus, so treat it as a hunch worth having.`,
    };
  }

  return {
    lead: `Maybe ${dish.name}`,
    note: `Only ${places} below hint at it — a guess rather than a plan. Check the menu before you commit.`,
  };
}
