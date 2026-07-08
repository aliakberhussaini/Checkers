/* Thin PostHog wrapper. The real project key is NEVER committed to this repo:
 * it's read at runtime from "analytics.local.json", a gitignored file that
 * only ever exists on your own machine (see README "Analytics" for setup).
 * Until that file exists with a real key, every capture() call just logs to
 * the console instead — the game behaves identically either way, and
 * analytics is additive and can never break play (every call is wrapped in
 * try/catch, and fetch() failures, unlike a <script>/<img> 404, produce no
 * browser console noise on their own).
 */
(function (global) {
  'use strict';

  var DEFAULT_HOST = 'https://us.i.posthog.com'; // EU cloud project? override "host" in analytics.local.json
  var LOCAL_CONFIG_URL = 'analytics.local.json';

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
            person_profiles: 'identified_only'
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

  function init() {
    var request;
    try { request = fetch(LOCAL_CONFIG_URL, { cache: 'no-store' }); }
    catch (e) { request = Promise.reject(e); }
    Promise.resolve(request)
      .then(function (res) { return (res && res.ok) ? res.json() : null; })
      .catch(function () { return null; })
      .then(function (cfg) {
        if (cfg && typeof cfg.key === 'string' && cfg.key && cfg.key.indexOf('REPLACE_WITH') === -1) {
          key = cfg.key;
          if (typeof cfg.host === 'string' && cfg.host) host = cfg.host;
          outcome = 'live';
          loadSdk();
        } else {
          outcome = 'noop';
          console.info('[analytics] No local PostHog key found (see README "Analytics") — events log to the console only.');
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
