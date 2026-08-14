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
import { LocationError, currentPosition, formatDistance, walkingMinutes } from './geo.js';
import { PlacesError, findNearbyPlaces, geocode } from './places.js';
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
  view: 'map',
  sort: 'best',
};

/** Aborts an in-flight lookup when the user starts another one. */
let pendingSearch = null;

const $ = (id) => document.getElementById(id);
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

// ---------------------------------------------------------------- rendering

function renderOptions(step) {
  const mount = $(step.mount);
  mount.innerHTML = '';

  step.options.forEach((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option';
    button.role = 'radio';
    button.dataset.value = option.id;
    button.setAttribute('aria-checked', String(state[step.key] === option.id));
    button.innerHTML = `
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

function renderDiagnosis() {
  const result = diagnose(state);
  $('results-title').textContent = result.headline;
  $('diagnosis-verdict').textContent = result.verdict;

  const list = $('dish-list');
  list.innerHTML = '';
  result.matches.forEach((dish, index) => {
    const item = document.createElement('li');
    item.className = 'dish';
    if (index === 0) item.classList.add('dish--top');
    item.innerHTML = `
      <p class="dish__name">${escapeHtml(dish.name)}</p>
      <p class="dish__note">${escapeHtml(dish.note)}</p>
    `;
    list.append(item);
  });

  renderSwap(result);
  return result;
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
  `https://www.openstreetmap.org/directions?to=${place.lat}%2C${place.lon}`;

function badges(place) {
  const marks = [];
  if (place.cuisineMatch) marks.push('<span class="badge badge--match">cuisine match</span>');
  else if (place.nameMatch) marks.push('<span class="badge">likely match</span>');
  if (place.takeaway) marks.push('<span class="badge">takeaway</span>');
  if (place.outdoorSeating) marks.push('<span class="badge">outdoor seating</span>');
  if (place.vegetarian) marks.push('<span class="badge">veg options</span>');
  return marks.join('');
}

const popupHtml = (place) => `
  <strong>${escapeHtml(place.name)}</strong><br />
  <span class="popup__meta">${escapeHtml(place.cuisine || place.amenity.replace('_', ' '))}
  · ${formatDistance(place.distance)}</span><br />
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

  sortPlaces(state.places).forEach((place) => {
    const item = document.createElement('li');
    item.className = 'place';
    item.innerHTML = `
      <div class="place__head">
        <h3 class="place__name">${escapeHtml(place.name)}</h3>
        <span class="place__distance">${formatDistance(place.distance)}</span>
      </div>
      <p class="place__meta">
        <span class="place__type">${escapeHtml(place.cuisine.replace(/[;,]/g, ' · ') || place.amenity.replace('_', ' '))}</span>
        · ~${walkingMinutes(place.distance)} min walk
      </p>
      ${place.address ? `<p class="place__meta">${escapeHtml(place.address)}</p>` : ''}
      ${place.openingHours ? `<p class="place__hours">${escapeHtml(place.openingHours)}</p>` : ''}
      <div class="place__badges">${badges(place)}</div>
      <div class="place__links">
        <a href="${directionsUrl(place)}" target="_blank" rel="noreferrer">Directions</a>
        ${place.website ? `<a href="${escapeHtml(place.website)}" target="_blank" rel="noreferrer">Website</a>` : ''}
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
  if (state.places.length === 0) return;

  // Report how far the results actually reach, not how far we searched — the
  // radius widens in fixed steps and would overstate the distance.
  const reach = Math.max(...state.places.map((place) => place.distance));
  const matches = state.places.filter((place) => place.tier === 0).length;
  $('results-count').textContent = matches > 0
    ? `${state.places.length} places within ${formatDistance(reach)} · ${matches} on-cuisine`
    : `${state.places.length} places within ${formatDistance(reach)}`;

  renderList();

  if (mapView.isAvailable()) {
    mapView.ensureMap($('map'));
    mapView.renderPlaces(state.origin, state.places, popupHtml);
    mapView.refresh();
  }
  setView(mapView.isAvailable() ? state.view : 'list');
}

function setView(view) {
  state.view = view;
  $('map-panel').hidden = view !== 'map';
  $('list-panel').hidden = view !== 'list';
  document.querySelectorAll('.toggle__btn').forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  if (view === 'map') mapView.refresh();
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
  const { terms, cuisine } = diagnose(state);

  setStatus(`Looking for ${cuisine.label} places near ${label}…`, 'busy');
  $('results').hidden = true;

  try {
    const { places, radius } = await findNearbyPlaces(origin, {
      cuisineTags: cuisine.osmCuisines,
      nameTerms: terms,
      signal: controller.signal,
    });

    if (controller.signal.aborted) return;
    state.places = places;
    state.radius = radius;

    if (places.length === 0) {
      setStatus(`No ${cuisine.label} places within ${formatDistance(radius)}. Try one of the alternatives above, or search a different area.`, 'warn');
      renderResults();
      return;
    }

    setStatus(`Near ${label}.`, 'ok');
    renderResults();
  } catch (error) {
    if (error.name === 'AbortError') return;
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

  document.querySelectorAll('.toggle__btn').forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });

  $('sort-select').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderList();
  });

  $('place-list').addEventListener('click', (event) => {
    const id = event.target.closest('[data-focus]')?.dataset.focus;
    if (!id) return;
    setView('map');
    mapView.focusPlace(id);
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
  bindEvents();
  if (!restoreFromHash()) renderStep();
}

init();
