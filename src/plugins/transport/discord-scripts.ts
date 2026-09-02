/**
 * Registry of every script the Discord adapter evaluates in the page, with
 * the only side effects each is allowed. The read-only posture is a tested
 * property of this table (see test/discord-read-only.test.ts), not a promise
 * in a README.
 *
 * Adding a page script means adding it here; the test fails if a function
 * marked SELF-CONTAINED in a Discord module is missing from the registry,
 * and if any script's source or built expression contains an input, network,
 * storage, or navigation primitive it has not declared.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { buildExtractMessagesExpression, extractMessages, renderText } from "./discord-dom.js";
import {
  buildMountedCountExpression,
  buildScrollNudgeExpression,
  mountedCount,
  scrollNudge,
} from "./discord-history.js";
import {
  buildListExpression,
  listChannels,
  listDms,
  listGuilds,
  mountedExpression,
  navigateExpression,
} from "./discord-nav.js";

/**
 * Side effects a page script may declare. Anything not listed here is
 * forbidden for every script; anything listed here is forbidden unless the
 * script declares it.
 */
export type DeclaredEffect =
  /** Push a same-origin path built from validated ids onto history and dispatch `popstate` (a route change, not a reload). */
  | "navigate-same-origin"
  /** Set `scrollTop` on the message scroller and dispatch a synthetic `scroll` event on it. */
  | "scroll-message-list";

export interface PageScript {
  name: string;
  /** The in-page function whose source ships to the browser, when there is one. */
  fn: ((...args: never[]) => unknown) | null;
  /** A representative built expression, exactly as it would be sent. */
  sample: () => string;
  effects: readonly DeclaredEffect[];
}

const SNOWFLAKE = "1520443442982031486";

export const PAGE_SCRIPTS: readonly PageScript[] = [
  { name: "extractMessages", fn: extractMessages, sample: () => buildExtractMessagesExpression({ channelId: SNOWFLAKE }), effects: [] },
  { name: "renderText", fn: renderText, sample: () => buildExtractMessagesExpression({ channelId: SNOWFLAKE }), effects: [] },
  { name: "listDms", fn: listDms, sample: () => buildListExpression("listDms"), effects: [] },
  { name: "listGuilds", fn: listGuilds, sample: () => buildListExpression("listGuilds"), effects: [] },
  { name: "listChannels", fn: listChannels, sample: () => buildListExpression("listChannels"), effects: [] },
  { name: "mountedExpression", fn: null, sample: () => mountedExpression(SNOWFLAKE), effects: [] },
  { name: "navigateExpression", fn: null, sample: () => navigateExpression(`/channels/@me/${SNOWFLAKE}`), effects: ["navigate-same-origin"] },
  { name: "scrollNudge", fn: scrollNudge, sample: () => buildScrollNudgeExpression(), effects: ["scroll-message-list"] },
  { name: "mountedCount", fn: mountedCount, sample: () => buildMountedCountExpression(), effects: [] },
];

/**
 * Primitives no page script may use, ever. Matched as substrings against
 * the function source and the built expression.
 */
export const FORBIDDEN_PRIMITIVES: readonly string[] = [
  // Input and focus
  ".focus(", ".click(", ".submit(", "execCommand", "KeyboardEvent", "InputEvent", "MouseEvent", "PointerEvent",
  "contenteditable", "textbox", ".value =", ".value=", "innerHTML", "outerHTML", "insertAdjacentHTML",
  // Network with the user's session
  "fetch(", "XMLHttpRequest", "WebSocket(", "sendBeacon", "EventSource",
  // Storage and identity
  "localStorage", "sessionStorage", "indexedDB", "document.cookie", "caches.",
  // Script and frame injection
  "eval(", "new Function", "createElement(\"script\"", "createElement('script'", "<iframe", "importScripts",
  // Discord's own client internals
  "webpackChunk", "__DISCORD", "token",
];

/**
 * Primitives allowed only under a declared effect. `dispatchEvent` is
 * checked separately: it is allowed under either effect, and the event type
 * must be the one that effect exists for (`scroll` or `popstate`).
 */
export const GATED_PRIMITIVES: Readonly<Record<DeclaredEffect, readonly string[]>> = {
  "navigate-same-origin": ["location.assign", "location.href", "location.replace", "history.pushState", "history.replaceState", "PopStateEvent"],
  "scroll-message-list": ["scrollTop", "scrollTo(", "scrollBy(", "scrollIntoView"],
};
