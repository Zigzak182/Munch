/**
 * Munch configuration.
 *
 * Paste your Google Maps Platform API key below and redeploy. Without one the
 * app still runs, but falls back to OpenStreetMap venue data and hides the
 * map — see the README for the trade-off.
 *
 * IMPORTANT: this file ships to the browser, so the key is public. That is
 * normal for Maps Platform keys, but it is only safe if you restrict it:
 *
 *   1. Google Cloud Console → APIs & Services → Credentials → your key
 *   2. Application restrictions → Websites → add your site, e.g.
 *        https://yourname.github.io/*
 *   3. API restrictions → restrict to: Maps JavaScript API, Places API (New),
 *      Geocoding API
 *   4. Set a billing budget alert so a leaked key cannot run up a bill
 *
 * An unrestricted key on a public site will eventually be scraped and used.
 */
window.MUNCH_CONFIG = {
  /** Google Maps Platform API key. Leave empty to run without Google. */
  googleMapsApiKey: 'AIzaSyAgzQbVlTCiPP0zL-Y_NPdKj3yOmNNYjqc',

  /**
   * Show photos on venue cards.
   *
   * Photos are billed per image fetched, separately from the search itself,
   * so this is the most expensive part of a results screen. Set to false to
   * turn them off entirely.
   */
  showPhotos: true,

  /**
   * How many cards may show a photo, counted from the top of the list.
   *
   * A fully scrolled list of 20 venues would be 20 billed photo requests.
   * Capping the top few keeps the visual hook on the results you actually
   * look at. Raise it for a richer list, lower it (or 0) to spend less.
   */
  photoLimit: 3,

  /**
   * Optional Map ID, used for cloud-based map styling. Leave empty to use
   * Google's demo style. Create one under Google Maps Platform → Map
   * Management to restyle the map without touching code.
   */
  mapId: '',
};
