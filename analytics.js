/* Thin PostHog wrapper. Loads the SDK asynchronously from PostHog's own CDN
 * (the same "array.js" bundle their official inline snippet injects — see
 * https://posthog.com/docs/libraries/js) and queues capture() calls made
 * before it finishes loading. If no project key is configured, every call
 * just logs to the console instead: the game behaves identically either way,
 * analytics is additive and can never break play (see try/catch in capture).
 *
 * To enable real capture: create a free project at https://posthog.com,
 * copy its "Project API key" from Project Settings, and paste it below.
 */
(function (global) {
  'use strict';

  var POSTHOG_KEY = 'phc_REPLACE_WITH_YOUR_POSTHOG_PROJECT_API_KEY';
  var POSTHOG_HOST = 'https://us.i.posthog.com'; // EU cloud project? use https://eu.i.posthog.com

  var queue = [];
  var ready = false;

  function configured() {
    return typeof POSTHOG_KEY === 'string' && POSTHOG_KEY.indexOf('REPLACE_WITH') === -1;
  }

  function flush() {
    while (queue.length) {
      var q = queue.shift();
      try { global.posthog.capture(q[0], q[1]); } catch (e) { /* never break the game */ }
    }
  }

  function init() {
    if (!configured()) {
      console.info('[analytics] No PostHog project key set (see README "Analytics") — events log to the console only.');
      return;
    }
    try {
      // Same transform PostHog's own inline snippet applies to derive the
      // asset CDN host from api_host (".i.posthog.com" -> "-assets.i.posthog.com").
      var assetsHost = POSTHOG_HOST.replace('.i.posthog.com', '-assets.i.posthog.com');
      var script = document.createElement('script');
      script.src = assetsHost + '/static/array.js';
      script.async = true;
      script.onload = function () {
        try {
          global.posthog.init(POSTHOG_KEY, {
            api_host: POSTHOG_HOST,
            capture_pageview: true,
            person_profiles: 'identified_only'
          });
          ready = true;
          flush();
        } catch (e) { /* never break the game */ }
      };
      script.onerror = function () {
        console.warn('[analytics] Could not load PostHog (offline or blocked) — events will log to the console only.');
      };
      document.head.appendChild(script);
    } catch (e) { /* never break the game */ }
  }

  function capture(event, props) {
    try {
      if (!configured()) { console.debug('[analytics:noop]', event, props || {}); return; }
      if (ready && global.posthog) global.posthog.capture(event, props || {});
      else queue.push([event, props || {}]);
    } catch (e) { /* never break the game */ }
  }

  global.Analytics = { init: init, capture: capture, isConfigured: configured };
  init();
})(typeof window !== 'undefined' ? window : this);
