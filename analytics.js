/* Thin PostHog wrapper, reading its key from a JSON file rather than source
 * so nothing here has to change between local dev and production:
 *  - "analytics.local.json" (gitignored) — a personal override, e.g. to
 *    point your own local testing at a separate/throwaway PostHog project.
 *    Never committed.
 *  - "analytics.config.json" (committed) — the real production key. This
 *    IS safe to commit: a PostHog *project* API key (the "phc_..." kind
 *    this file expects) is a public, write-only key by design — the same
 *    way a Google Analytics ID sits in a page's plain HTML. It cannot read
 *    or modify account data. (A PostHog *personal* API key, "phx_...", is
 *    the secret one — that must never appear here.)
 * If neither file has a valid key, every capture() call just logs to the
 * console instead — the game behaves identically either way, and analytics
 * is additive and can never break play (every call is wrapped in try/catch,
 * and fetch() failures, unlike a <script>/<img> 404, produce no browser
 * console noise on their own).
 */
(function (global) {
  'use strict';

  var DEFAULT_HOST = 'https://us.i.posthog.com'; // EU cloud project? override "host" in the config file
  var LOCAL_CONFIG_URL = 'analytics.local.json';
  var PUBLIC_CONFIG_URL = 'analytics.config.json';

  var key = null;
  var host = DEFAULT_HOST;
  var pending = [];        // capture() calls made before we know the outcome
  var outcome = null;      // null (deciding) | 'noop' (no key found) | 'live' (key found)
  var sdkReady = false;    // outcome === 'live' AND posthog.init() has run

  function configured() { return outcome === 'live'; }

  function drain() {
    if (outcome === 'noop') {
      while (pending.length) {
        var q = pending.shift();
        console.debug('[analytics:noop]', q[0], q[1]);
      }
    } else if (outcome === 'live' && sdkReady) {
      while (pending.length) {
        var q2 = pending.shift();
        try { global.posthog.capture(q2[0], q2[1]); } catch (e) { /* never break the game */ }
      }
    }
    // else: still waiting on the config fetch, or the key is known but the
    // SDK script hasn't finished loading yet — leave pending as-is; drain()
    // runs again from the fetch .then() below or from the script's onload.
  }

  function loadSdk() {
    try {
      // Same transform PostHog's own inline snippet applies to derive the
      // asset CDN host from api_host (".i.posthog.com" -> "-assets.i.posthog.com").
      var assetsHost = host.replace('.i.posthog.com', '-assets.i.posthog.com');
      var script = document.createElement('script');
      script.src = assetsHost + '/static/array.js';
      script.async = true;
      script.onload = function () {
        try {
          global.posthog.init(key, {
            api_host: host,
            capture_pageview: true,
            person_profiles: 'identified_only',
            // Keep capture scoped to exactly the deliberate events this file
            // and ui.js send — no session replay, no DOM autocapture, no
            // surveys. PostHog's own defaults turn all three on, which would
            // silently capture far more than interaction/outcome metadata.
            disable_session_recording: true,
            autocapture: false,
            capture_dead_clicks: false,
            disable_surveys: true
          });
          sdkReady = true;
          drain();
        } catch (e) { /* never break the game */ }
      };
      script.onerror = function () {
        console.warn('[analytics] Could not load PostHog (offline or blocked) — events will log to the console only.');
      };
      document.head.appendChild(script);
    } catch (e) { /* never break the game */ }
  }

  function fetchConfig(url) {
    var request;
    try { request = fetch(url, { cache: 'no-store' }); }
    catch (e) { request = Promise.reject(e); }
    return Promise.resolve(request)
      .then(function (res) { return (res && res.ok) ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (cfg) {
        var valid = cfg && typeof cfg.key === 'string' && cfg.key && cfg.key.indexOf('REPLACE_WITH') === -1;
        return valid ? cfg : null;
      });
  }

  function init() {
    // Personal override first (if present), else the committed production key.
    fetchConfig(LOCAL_CONFIG_URL)
      .then(function (cfg) { return cfg || fetchConfig(PUBLIC_CONFIG_URL); })
      .then(function (cfg) {
        if (cfg) {
          key = cfg.key;
          if (typeof cfg.host === 'string' && cfg.host) host = cfg.host;
          outcome = 'live';
          loadSdk();
        } else {
          outcome = 'noop';
          console.info('[analytics] No PostHog key found (see README "Analytics") — events log to the console only.');
        }
        drain();
      });
  }

  function capture(event, props) {
    try {
      pending.push([event, props || {}]);
      drain();
    } catch (e) { /* never break the game */ }
  }

  global.Analytics = { init: init, capture: capture, isConfigured: configured };
  init();
})(typeof window !== 'undefined' ? window : this);
