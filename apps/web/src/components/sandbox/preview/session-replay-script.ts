/**
 * PostHog session-replay bootstrap for the sandbox Preview iframe.
 *
 * PostHog / rrweb only records SAME-origin iframes. Our Preview iframe loads a
 * deco site on a different origin (`*.preview-studio.decocms.com`), so without
 * help the preview canvas is a blank rectangle in replays. PostHog's fix is
 * cross-origin iframe recording: load posthog-js inside the child too, init it
 * with `recordCrossOriginIframes: true`, and it forwards its rrweb stream to
 * the parent (which also sets the flag — see `lib/posthog-client.ts`) via
 * postMessage instead of ingesting on its own. One stitched recording results.
 *
 * The script string below is eval'd inside the iframe by the sandbox bootstrap
 * (`IFRAME_BOOTSTRAP_SCRIPT` in `packages/sandbox/shared.ts`), which listens
 * for `visual-editor::activate` and runs `new Function(script)()`. That
 * bootstrap is injected ONLY into sandbox dev-server previews (by the daemon
 * proxy), never into the production-fallback frame — so this recording is
 * scoped to deco sites the user is actively editing in Preview, by
 * construction.
 *
 * Privacy: the child mirrors the parent's masking (`maskAllInputs`,
 * `blockClass: "ph-no-capture"`) and disables autocapture / pageviews /
 * pageleaves so it ONLY contributes the replay stream — no duplicate product
 * analytics events from inside the customer's site.
 */

/** Distinct guard flag on the iframe's window so a re-injection is a no-op. */
const REPLAY_GUARD = "__phSessionReplayActive";

/**
 * Build the self-contained bootstrap script for the given PostHog project.
 *
 * `key`/`host` come from `/api/config` (`usePublicConfig().posthog`) and are
 * JSON-encoded so they can't break out of the string literal. `host` is the
 * same first-party reverse proxy the parent uses; it must serve
 * `/static/array.js` (the standard PostHog reverse-proxy contract).
 */
export function buildSessionReplayScript(key: string, host: string): string {
  const k = JSON.stringify(key);
  const h = JSON.stringify(host);
  return `(function(){
  if (window.${REPLAY_GUARD}) return;
  window.${REPLAY_GUARD} = true;
  try {
    !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug getPageViewId".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
    window.posthog.init(${k}, {
      api_host: ${h},
      // Contribute ONLY the replay stream to the parent — no analytics events.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_performance: false,
      capture_exceptions: false,
      disable_surveys: true,
      person_profiles: "never",
      session_recording: {
        maskAllInputs: true,
        blockClass: "ph-no-capture",
        recordCrossOriginIframes: true
      }
    });
  } catch (err) {
    window.${REPLAY_GUARD} = false;
    console.error("[session-replay] bootstrap failed", err);
  }
})();`;
}
