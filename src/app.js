/**
 * Screen flow and DOM wiring.
 *
 * The quiz is a three-step state machine — texture → flavour → results. Only
 * two questions are asked; the cuisine is derived from the answers, and the
 * results screen offers the runner-ups if the derived one doesn't land.
 * Answers live in `state`, are mirrored into the URL hash so a diagnosis can
 * be shared or reloaded, and only the results step touches the network.
 */

import { CUISINES, FLAVORS, TEXTURES } from './data.js';
import { diagnose } from './diagnosis.js';
import { LocationError, currentPosition, formatDistance, travelTime } from './geo.js';
import { PlacesError, activeProvider, findNearbyPlaces, geocode } from './places.js';
import { describeSuggestion, suggestDish } from './suggest.js';
import { initAccount } from './account.js';
import { photoLimit } from './config.js';
import { playReveal } from './reveal.js';
import * as mapView from './map.js';

const STEPS = [
  { key: 'texture', label: 'Feel', options: TEXTURES, mount: 'texture-options' },
  { key: 'flavor', label: 'Flavour', options: FLAVORS, mount: 'flavor-options' },
  { key: 'results', label: 'Results' },
];

/** Index of the results screen. */
const RESULTS = STEPS.length - 1;

const state = {
  step: 0,
  texture: null,
  flavor: null,
  /** Only set when the user overrides the derived cuisine. */
  cuisine: null,
  origin: null,
  originLabel: '',
  places: [],
  radius: 0,
  sort: 'best',
};

/** Aborts an in-flight lookup when the user starts another one. */
let pendingSearch = null;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

// ---------------------------------------------------------------- rendering

/**
 * The Munch+ mark: the wordmark plus a candy-striped plus sign.
 *
 * The stripe pattern is defined once in the document, so the `+` is a real
 * shape rather than a character that may or may not have a glyph — there is no
 * candy cane in the emoji set, and a missing glyph renders as a blank box.
 */
const PREMIUM_BADGE = `
  <span class="premium__word" aria-hidden="true">Munch</span>
  <svg class="premium__plus" viewBox="0 0 12 12" aria-hidden="true" focusable="false">
    <path d="M4.6 0h2.8v4.6H12v2.8H7.4V12H4.6V7.4H0V4.6h4.6z"
          fill="url(#munch-cane)" stroke="rgba(120,20,10,.35)" stroke-width=".5"
          stroke-linejoin="round" />
  </svg>`;

function renderOptions(step) {
  const mount = $(step.mount);
  mount.innerHTML = '';

  step.options.forEach((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = option.premium ? 'option option--premium' : 'option';
    button.role = 'radio';
    button.dataset.value = option.id;
    button.setAttribute('aria-checked', String(state[step.key] === option.id));
    button.innerHTML = `
      ${option.premium ? `<span class="premium" role="img" aria-label="Munch Plus">${PREMIUM_BADGE}</span>` : ''}
      <span class="option__emoji" aria-hidden="true">${option.emoji}</span>
      <span class="option__label">${escapeHtml(option.label)}</span>
      <span class="option__blurb">${escapeHtml(option.blurb)}</span>
    `;
    button.addEventListener('click', () => choose(step.key, option.id));
    mount.append(button);
  });
}

function renderProgress() {
  const list = $('progress-list');
  list.innerHTML = '';

  STEPS.forEach((step, index) => {
    const answered = step.key !== 'results' && state[step.key];
    const item = document.createElement('li');
    item.className = 'progress__item';
    if (index === state.step) item.classList.add('is-current');
    if (answered) item.classList.add('is-done');

    if (answered && index < state.step) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'progress__btn';
      button.textContent = step.label;
      button.addEventListener('click', () => goTo(index));
      item.append(button);
    } else {
      item.textContent = step.label;
    }

    if (index === state.step) item.setAttribute('aria-current', 'step');
    list.append(item);
  });
}

function renderStep() {
  STEPS.forEach((step, index) => {
    const screen = document.querySelector(`.screen[data-step="${index}"]`);
    screen.hidden = index !== state.step;
  });
  renderProgress();

  // Move focus to the new heading so screen readers announce the step change.
  const heading = document.querySelector(`.screen[data-step="${state.step}"] .screen__title`);
  if (heading) {
    heading.tabIndex = -1;
    heading.focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * The diagnosis is a craving profile, not a dish.
 *
 * Naming a specific dish above a list of venues implies those venues serve it,
 * and no available API can tell us what is on a restaurant's current menu —
 * Google Places has no menu field. So the matched dishes stay internal, where
 * they pick the cuisine and sharpen the venue search, and the screen claims
 * only what it can stand behind. Venue cards link out to the business instead.
 */
function renderDiagnosis() {
  const result = diagnose(state);
  $('results-title').textContent = result.headline;
  $('diagnosis-verdict').textContent = result.verdict;

  // The dessert path is the Munch+ feature, so it says so.
  const flag = $('premium-flag');
  flag.hidden = result.course !== 'dessert';
  flag.innerHTML = flag.hidden ? '' : PREMIUM_BADGE;
  if (!flag.hidden) {
    flag.setAttribute('role', 'img');
    flag.setAttribute('aria-label', 'Munch Plus');
  }

  renderSwap(result);
  return result;
}

/**
 * What the venues themselves point at.
 *
 * This is the only place a dish name reaches the screen, and it is read *from*
 * the results rather than asserted over them — see suggest.js. When nothing
 * supports a dish, nothing is shown; the wording never says a venue serves
 * anything, because that is not something we can know.
 */
function renderSuggestion(result) {
  const element = $('suggestion');
  const suggestion = suggestDish(result.candidates, state.places, { cuisine: result.cuisine });

  if (!suggestion) {
    element.hidden = true;
    element.innerHTML = '';
    return;
  }

  const { lead, note } = describeSuggestion(suggestion);
  element.dataset.confidence = suggestion.confidence;
  element.innerHTML = `
    <span class="suggestion__lead">${escapeHtml(lead)}</span>
    <span class="suggestion__note">${escapeHtml(note)}</span>
  `;
  element.hidden = false;
}

/**
 * The escape hatch from a derived cuisine. It sits below the diagnosis rather
 * than in front of it: the app commits to an answer first, and only then
 * offers the runner-ups — which also rescues someone whose neighbourhood has
 * none of the first choice.
 */
function renderSwap(result) {
  const swap = $('cuisine-swap');
  const options = $('swap-options');
  options.innerHTML = '';

  $('swap-label').textContent = result.derived
    ? `Not feeling ${result.cuisine.label}?`
    : 'Or try:';

  result.alternatives.forEach((cuisine) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swap__btn';
    button.innerHTML = `<span aria-hidden="true">${cuisine.emoji}</span> ${escapeHtml(cuisine.label)}`;
    button.addEventListener('click', () => {
      state.cuisine = cuisine.id;
      renderDiagnosis();
      syncHash();
      if (state.origin) search(state.origin, state.originLabel);
    });
    options.append(button);
  });

  swap.hidden = result.alternatives.length === 0;
}

const directionsUrl = (place) =>
  `https://www.google.com/maps/dir/?api=1&destination=${place.lat}%2C${place.lon}`;

function badges(place) {
  const marks = [];
  if (place.cuisineMatch) marks.push('<span class="badge badge--match">cuisine match</span>');
  else if (place.nameMatch) marks.push('<span class="badge">likely match</span>');
  if (place.openNow === true) marks.push('<span class="badge badge--open">open now</span>');
  if (place.openNow === false) marks.push('<span class="badge badge--shut">closed</span>');
  if (place.takeaway) marks.push('<span class="badge">takeaway</span>');
  if (place.outdoorSeating) marks.push('<span class="badge">outdoor seating</span>');
  if (place.vegetarian) marks.push('<span class="badge">veg options</span>');
  return marks.join('');
}

/**
 * Venue photo — behind a tap, not automatic.
 *
 * Google bills each photo fetched, so loading one for every card charged for
 * images nobody had asked to see. Cards within `photoLimit` offer a button
 * instead; the image is only requested when someone taps it, which means an
 * ordinary search costs nothing in photos.
 */
function photoHtml(place, index, limit) {
  if (index >= limit || !place.photoUrl) return '';

  return `
    <div class="place__photo-slot" data-photo-slot="${escapeHtml(place.id)}">
      <button class="place__photo-btn" type="button" data-photo="${escapeHtml(place.id)}"
              aria-label="Show photo of ${escapeHtml(place.name)}">
        <span aria-hidden="true">📷</span> Show photo
      </button>
    </div>
  `;
}

/**
 * Swap a photo button for the image it stands in for.
 *
 * The fetch — and the charge — happens here, on the tap, and only once: the
 * button is replaced, so a second tap is not possible.
 */
function revealPhoto(id) {
  const place = state.places.find((entry) => entry.id === id);
  const slot = document.querySelector(`[data-photo-slot="${CSS.escape(id)}"]`);
  if (!place?.photoUrl || !slot) return;

  const credit = place.photoAttribution;
  const creditHtml = credit
    ? `<figcaption class="place__credit">Photo: ${credit.uri
      ? `<a href="${escapeHtml(credit.uri)}" target="_blank" rel="noreferrer">${escapeHtml(credit.name)}</a>`
      : escapeHtml(credit.name)}</figcaption>`
    : '';

  slot.innerHTML = `
    <figure class="place__photo">
      <img src="${escapeHtml(place.photoUrl)}" alt="" decoding="async" />
      ${creditHtml}
    </figure>
  `;
}

/** Star rating with review count, when the provider supplies one. */
function ratingHtml(place) {
  if (typeof place.rating !== 'number') return '';
  const count = place.ratingCount ? ` (${place.ratingCount.toLocaleString()})` : '';
  const price = place.priceLevel ? ` · ${escapeHtml(place.priceLevel)}` : '';
  return `<p class="place__rating"><span aria-hidden="true">★</span> ${place.rating.toFixed(1)}${count}${price}</p>`;
}

const popupHtml = (place) => `
  <strong>${escapeHtml(place.name)}</strong><br />
  <span class="popup__meta">${escapeHtml(place.typeLabel)} · ${formatDistance(place.distance)}${
  typeof place.rating === 'number' ? ` · ★ ${place.rating.toFixed(1)}` : ''
}</span><br />
  <a href="${directionsUrl(place)}" target="_blank" rel="noreferrer">Directions</a>
`;

function sortPlaces(places) {
  const copy = [...places];
  if (state.sort === 'distance') return copy.sort((a, b) => a.distance - b.distance);
  if (state.sort === 'name') return copy.sort((a, b) => a.name.localeCompare(b.name));
  return copy.sort((a, b) => a.tier - b.tier || a.distance - b.distance);
}

function renderList() {
  const list = $('place-list');
  list.innerHTML = '';

  // Read once per render: the cap follows display order, so re-sorting moves
  // the photos to whichever cards are now on top.
  const limit = photoLimit();

  sortPlaces(state.places).forEach((place, index) => {
    const item = document.createElement('li');
    item.className = 'place';
    item.innerHTML = `
      <div class="place__head">
        <h3 class="place__name">${escapeHtml(place.name)}</h3>
        <span class="place__distance">${formatDistance(place.distance)}</span>
      </div>
      ${photoHtml(place, index, limit)}
      <p class="place__meta">
        <span class="place__type">${escapeHtml(place.typeLabel)}</span>
        · ${travelTime(place.distance).label}
      </p>
      ${ratingHtml(place)}
      ${place.address ? `<p class="place__meta">${escapeHtml(place.address)}</p>` : ''}
      ${place.hoursText ? `<p class="place__hours">${escapeHtml(place.hoursText)}</p>` : ''}
      <div class="place__badges">${badges(place)}</div>
      <div class="place__links">
        <a href="${directionsUrl(place)}" target="_blank" rel="noreferrer">Directions</a>
        ${place.website ? `<a href="${escapeHtml(place.website)}" target="_blank" rel="noreferrer">Website</a>` : ''}
        ${place.mapsUrl ? `<a href="${escapeHtml(place.mapsUrl)}" target="_blank" rel="noreferrer">Menu &amp; photos</a>` : ''}
        ${place.phone ? `<a href="tel:${escapeHtml(place.phone.replace(/\s/g, ''))}">Call</a>` : ''}
        <button class="link-btn" type="button" data-focus="${escapeHtml(place.id)}">Show on map</button>
      </div>
    `;
    list.append(item);
  });
}

function renderResults() {
  const results = $('results');
  results.hidden = state.places.length === 0;
  if (state.places.length === 0) {
    $('suggestion').hidden = true;
    return;
  }

  renderSuggestion(diagnose(state));

  // Report how far the results actually reach, not how far we searched — the
  // radius widens in fixed steps and would overstate the distance.
  const reach = Math.max(...state.places.map((place) => place.distance));
  const matches = state.places.filter((place) => place.tier === 0).length;
  $('results-count').textContent = matches > 0
    ? `${state.places.length} places within ${formatDistance(reach)} · ${matches} on-cuisine`
    : `${state.places.length} places within ${formatDistance(reach)}`;

  renderList();

  // The map loads asynchronously and sits above the list; a failure hides it
  // and leaves the list carrying the results on its own.
  $('map-panel').hidden = !mapView.isAvailable();
  if (mapView.isAvailable()) {
    mapView.ensureMap($('map'))
      .then(() => mapView.renderPlaces(state.origin, state.places, popupHtml))
      .catch((error) => {
        showSetupNotice(error.message);
        $('map-panel').hidden = true;
      });
  }
}

/** Surface a configuration problem the user has to fix themselves. */
function showSetupNotice(message) {
  const notice = $('setup-notice');
  notice.textContent = message;
  notice.hidden = !message;
}

/**
 * Credit whichever provider actually answered, and say plainly when the app
 * is running in its reduced, keyless mode.
 */
function renderAttribution() {
  const attribution = $('attribution');
  const notes = {
    api: 'Venue data and maps from Google, fetched through the Munch API. Your location is'
      + ' sent to find nearby places, and is not stored by this app.',
    google: 'Venue data and maps from Google. Your location is sent to Google to find nearby'
      + ' places, and is not stored by this app.',
    osm: 'Venue data from <a href="https://www.openstreetmap.org/copyright" target="_blank"'
      + ' rel="noreferrer">OpenStreetMap</a> via Overpass &amp; Nominatim. Add a Google Maps'
      + ' API key in <code>munch.config.js</code> for better coverage and a map.',
  };
  attribution.innerHTML = notes[activeProvider()] ?? notes.osm;
}

function setStatus(message, tone = 'info') {
  const status = $('locator-status');
  status.textContent = message;
  status.dataset.tone = tone;
}

// ------------------------------------------------------------------- flow

async function choose(key, value) {
  state[key] = value;
  // The answers drive the cuisine, so a new answer re-derives it.
  state.cuisine = null;

  renderOptions(STEPS.find((entry) => entry.key === key));

  if (key !== 'flavor') {
    goTo(state.step + 1);
    return;
  }

  // Last answer: show the cuisine being decided, then go looking for it.
  goTo(RESULTS);
  await playReveal(diagnose(state));
  if (!state.origin) locateAndSearch();
}

function goTo(step) {
  state.step = step;
  renderStep();

  if (step === RESULTS) {
    renderDiagnosis();
    syncHash();
    if (state.origin) search(state.origin, state.originLabel);
  }
}

/** `#texture/flavor`, plus the cuisine only when the user pinned one. */
function hashFor({ texture, flavor, cuisine }) {
  if (!texture || !flavor) return '';
  return `#${texture}/${flavor}${cuisine ? `/${cuisine}` : ''}`;
}

function syncHash() {
  const hash = hashFor(state);
  if (hash) history.replaceState(null, '', hash);
}

/**
 * Restore from a shared link. The cuisine segment is optional — links made
 * before the cuisine question was dropped still carry one, and it is honoured
 * as a pin.
 */
function restoreFromHash() {
  const [texture, flavor, cuisine] = window.location.hash.replace(/^#/, '').split('/');
  const valid = TEXTURES.some((option) => option.id === texture)
    && FLAVORS.some((option) => option.id === flavor);
  if (!valid) return false;

  const pinned = CUISINES.some((option) => option.id === cuisine) ? cuisine : null;
  Object.assign(state, { texture, flavor, cuisine: pinned });
  STEPS.slice(0, RESULTS).forEach(renderOptions);
  goTo(RESULTS);
  return true;
}

// ---------------------------------------------------------------- searching

async function search(origin, label) {
  pendingSearch?.abort();
  const controller = new AbortController();
  pendingSearch = controller;

  state.origin = origin;
  state.originLabel = label;
  const { terms, cuisine, course, search: venueHints } = diagnose(state);

  const noun = course === 'dessert' ? `${cuisine.label} dessert` : cuisine.label;
  setStatus(`Looking for ${noun} places near ${label}…`, 'busy');
  $('results').hidden = true;

  try {
    const { places, radius } = await findNearbyPlaces(origin, {
      ...venueHints,
      nameTerms: terms,
      signal: controller.signal,
    });

    if (controller.signal.aborted) return;
    state.places = places;
    state.radius = radius;

    if (places.length === 0) {
      setStatus(`No ${noun} places within ${formatDistance(radius)}. Try one of the alternatives above, or search a different area.`, 'warn');
      renderResults();
      return;
    }

    setStatus(`Near ${label}.`, 'ok');
    renderResults();
  } catch (error) {
    if (error.name === 'AbortError') return;

    // Drop the previous search's results. They belong to a different
    // diagnosis, and leaving them in state means re-sorting would put them
    // back on screen underneath the new headline.
    state.places = [];
    renderResults();

    // A paywall refusal is not a failure to retry past — retrying produces
    // the same answer, so the advice would be wrong. Say what it is and
    // point at the way out.
    if (error instanceof PlacesError && error.code === 'upgrade') {
      setStatus(`${error.message} Pick another flavour to keep looking.`, 'warn');
      return;
    }

    const message = error instanceof PlacesError
      ? error.message
      : 'Something went wrong looking for places.';
    setStatus(`${message} You can retry, or search a place name.`, 'error');
  } finally {
    if (pendingSearch === controller) pendingSearch = null;
  }
}

async function locateAndSearch() {
  setStatus('Asking your browser for your location…', 'busy');
  try {
    const position = await currentPosition();
    await search(position, 'you');
  } catch (error) {
    const message = error instanceof LocationError
      ? error.message
      : 'Could not read your location.';
    setStatus(message, 'error');
    $('place-input').focus();
  }
}

async function searchPlaceName(query) {
  setStatus(`Finding “${query}”…`, 'busy');
  try {
    const match = await geocode(query);
    await search({ lat: match.lat, lon: match.lon }, match.label.split(',')[0]);
  } catch (error) {
    const message = error instanceof PlacesError ? error.message : 'Place search failed.';
    setStatus(message, 'error');
  }
}

// ------------------------------------------------------------------- events

function bindEvents() {
  document.querySelectorAll('[data-back]').forEach((button) => {
    button.addEventListener('click', () => goTo(Math.max(0, state.step - 1)));
  });

  $('use-location').addEventListener('click', locateAndSearch);

  $('place-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const query = $('place-input').value.trim();
    if (query) searchPlaceName(query);
  });

  $('sort-select').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderList();
  });

  // With both panes on screen, "Show on map" only has to bring the map into
  // view — on a phone it is directly above the list, off-screen.
  $('place-list').addEventListener('click', (event) => {
    const photoId = event.target.closest('[data-photo]')?.dataset.photo;
    if (photoId) {
      revealPhoto(photoId);
      return;
    }

    const id = event.target.closest('[data-focus]')?.dataset.focus;
    if (!id) return;
    mapView.focusPlace(id);
    $('map-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  // A pasted or edited hash is a same-document navigation, so nothing
  // re-renders unless we listen for it.
  window.addEventListener('hashchange', () => {
    if (window.location.hash && window.location.hash !== hashFor(state)) restoreFromHash();
  });

  $('restart').addEventListener('click', () => {
    Object.assign(state, { step: 0, texture: null, flavor: null, cuisine: null, places: [] });
    history.replaceState(null, '', window.location.pathname);
    STEPS.slice(0, RESULTS).forEach(renderOptions);
    $('results').hidden = true;
    setStatus('');
    goTo(0);
  });

  // Arrow-key navigation within an option group, per the radiogroup pattern.
  document.querySelectorAll('.options').forEach((group) => {
    group.addEventListener('keydown', (event) => {
      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
      const buttons = [...group.querySelectorAll('.option')];
      const index = buttons.indexOf(document.activeElement);
      if (index === -1) return;
      event.preventDefault();
      const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + delta + buttons.length) % buttons.length].focus();
    });
  });
}

function init() {
  STEPS.slice(0, RESULTS).forEach(renderOptions);
  renderAttribution();
  initAccount();

  // Signing in can turn Munch+ on mid-session, so a search refused a moment
  // ago is worth retrying rather than leaving the upgrade notice sitting
  // there under a diagnosis that would now work.
  document.addEventListener('munch:entitlement-changed', () => {
    if (state.origin && state.step === RESULTS) search(state.origin, state.originLabel);
  });

  bindEvents();
  if (!restoreFromHash()) renderStep();
}

init();
