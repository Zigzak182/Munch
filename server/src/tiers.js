/**
 * What each tier is allowed to do.
 *
 * This is the paywall. It is enforced here, on the server, because a paywall
 * enforced in the browser is a suggestion — the whole reason this service
 * exists.
 *
 * The limits are a cost ceiling as much as a product boundary: every search
 * that reaches Google is billed, so an identity that asks for hundreds is
 * either abusing the key or looping by accident, and neither should be
 * allowed to run up the bill.
 */

export const TIERS = {
  free: {
    id: 'free',
    label: 'Munch',
    courses: ['main'],
    searchesPerHour: 30,
    photosPerHour: 20,
  },
  plus: {
    id: 'plus',
    label: 'Munch+',
    courses: ['main', 'dessert'],
    searchesPerHour: 120,
    photosPerHour: 120,
  },
};

export const DEFAULT_TIER = 'free';

/** The named tier, or the free one. Never throws — an unknown tier is free. */
export const tierFor = (name) => TIERS[name] ?? TIERS[DEFAULT_TIER];

/** Whether a tier may search this course. */
export const allowsCourse = (name, course) => tierFor(name).courses.includes(course);

/**
 * What the client is told about a tier.
 *
 * Deliberately includes the courses: the app uses this to decide whether to
 * show the Munch+ upsell rather than guessing, so the server stays the single
 * source of truth for what is unlocked.
 */
export const describeTier = (name) => {
  const tier = tierFor(name);
  return {
    tier: tier.id,
    label: tier.label,
    courses: [...tier.courses],
    limits: { searchesPerHour: tier.searchesPerHour, photosPerHour: tier.photosPerHour },
  };
};
