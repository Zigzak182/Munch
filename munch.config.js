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
 *   2. Application restrictions → Websites → add every host the app is
 *      served from:
 *        https://www.what2food.com/*
 *        https://what2food.com/*
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
   * Offer photos on venue cards.
   *
   * Photos are billed per image fetched, so they load on tap rather than
   * automatically — a search costs nothing in photos unless someone asks to
   * see one. Set to false to remove the option entirely.
   */
  showPhotos: true,

  /**
   * How many cards offer a "Show photo" button, counted from the top.
   *
   * Nothing is fetched until one is tapped, so this bounds how many photos a
   * single results screen could ever charge for. 0 removes the buttons.
   */
  photoLimit: 3,

  /**
   * Optional Map ID, used for cloud-based map styling. Leave empty to use
   * Google's demo style. Create one under Google Maps Platform → Map
   * Management to restyle the map without touching code.
   */
  mapId: '',
};
