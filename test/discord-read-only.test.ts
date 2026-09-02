/**
 * The Discord adapter's read-only posture as a tested property: every page
 * script is registered, and no script uses an input, network, storage, or
 * navigation primitive it has not declared.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  FORBIDDEN_PRIMITIVES,
  GATED_PRIMITIVES,
  PAGE_SCRIPTS,
  type DeclaredEffect,
} from "../src/plugins/transport/discord-scripts.js";

const MODULES = ["discord-dom.ts", "discord-nav.ts", "discord-history.ts"];

function moduleSource(name: string): string {
  return readFileSync(new URL(`../src/plugins/transport/${name}`, import.meta.url), "utf8");
}

/** Names of exported functions whose doc comment says SELF-CONTAINED. */
function selfContainedExports(source: string): string[] {
  const names: string[] = [];
  const re = /\/\*\*([\s\S]*?)\*\/\s*export function (\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (/SELF-CONTAINED/.test(m[1])) names.push(m[2]);
  }
  return names;
}

function textsOf(script: (typeof PAGE_SCRIPTS)[number]): Array<[string, string]> {
  const out: Array<[string, string]> = [["expression", script.sample()]];
  if (script.fn) out.push(["source", script.fn.toString()]);
  return out;
}

test("every SELF-CONTAINED page function in the Discord modules is registered", () => {
  const registered = new Set(PAGE_SCRIPTS.map((s) => s.name));
  for (const mod of MODULES) {
    for (const name of selfContainedExports(moduleSource(mod))) {
      assert.ok(registered.has(name), `${mod}: ${name} is shipped to the page but not in PAGE_SCRIPTS`);
    }
  }
});

test("no page script uses a forbidden primitive", () => {
  for (const script of PAGE_SCRIPTS) {
    for (const [kind, text] of textsOf(script)) {
      for (const primitive of FORBIDDEN_PRIMITIVES) {
        assert.ok(!text.includes(primitive), `${script.name} ${kind} uses forbidden primitive ${JSON.stringify(primitive)}`);
      }
    }
  }
});

test("gated primitives appear only in scripts that declare the matching effect", () => {
  const effects = Object.keys(GATED_PRIMITIVES) as DeclaredEffect[];
  for (const script of PAGE_SCRIPTS) {
    for (const [kind, text] of textsOf(script)) {
      for (const effect of effects) {
        for (const primitive of GATED_PRIMITIVES[effect]) {
          const declared = script.effects.includes(effect);
          if (!declared) {
            assert.ok(!text.includes(primitive), `${script.name} ${kind} uses ${JSON.stringify(primitive)} without declaring ${effect}`);
          }
        }
      }
    }
  }
});

test("a declared effect is actually used, so declarations cannot rot into blanket permissions", () => {
  for (const script of PAGE_SCRIPTS) {
    for (const effect of script.effects) {
      const used = textsOf(script).some(([, text]) => GATED_PRIMITIVES[effect].some((p) => text.includes(p)));
      assert.ok(used, `${script.name} declares ${effect} but uses none of its primitives`);
    }
  }
});

test("dispatchEvent appears only under a declared effect and only with that effect's event type", () => {
  const allowed: Record<DeclaredEffect, string> = { "scroll-message-list": "scroll", "navigate-same-origin": "popstate" };
  for (const script of PAGE_SCRIPTS) {
    for (const [kind, text] of textsOf(script)) {
      const dispatches = [...text.matchAll(/dispatchEvent\(new (\w+)\("([^"]+)"/g)].map((m) => m[2]);
      if (script.effects.length === 0) {
        assert.ok(!text.includes("dispatchEvent"), `${script.name} ${kind} dispatches events without a declared effect`);
        continue;
      }
      const permitted = new Set(script.effects.map((e) => allowed[e]));
      assert.ok(dispatches.every((t) => permitted.has(t)), `${script.name} ${kind} dispatches ${dispatches.join(",")}; permitted ${[...permitted].join(",")}`);
    }
  }
});

test("the navigate effect pushes only /channels/ paths and never reloads", () => {
  for (const script of PAGE_SCRIPTS) {
    if (!script.effects.includes("navigate-same-origin")) continue;
    for (const [, text] of textsOf(script)) {
      const targets = [...text.matchAll(/history\.pushState\(\{\}, "", "([^"]*)"\)/g)].map((m) => m[1]);
      assert.ok(targets.length > 0, `${script.name} declares navigation but pushes nothing`);
      assert.ok(targets.every((t) => /^\/channels\//.test(t)), `${script.name} navigates to ${targets.join(",")}`);
      assert.ok(!/location\.(assign|href|replace)/.test(text), `${script.name} would reload the client`);
    }
  }
});

test("the forbidden list itself covers the message composer and the user's session", () => {
  for (const must of [".focus(", "execCommand", "KeyboardEvent", "fetch(", "document.cookie", "localStorage", "token"]) {
    assert.ok(FORBIDDEN_PRIMITIVES.includes(must));
  }
});
