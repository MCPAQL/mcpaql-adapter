/**
 * Minimal fake DOM for testing in-page extractors in Node without a browser
 * or any dependency. Implements exactly the surface `DomNode` needs plus a
 * small CSS selector subset:
 *   tag, #id, .class, [attr], [attr="v"], [attr^="v"], [attr*="v"],
 *   descendant (space) and child (>) combinators, and comma lists.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DomNode } from "../../src/plugins/transport/discord-dom.js";

export class FakeNode implements DomNode {
  readonly nodeType: number;
  readonly nodeValue: string | null;
  readonly tagName?: string;
  readonly attrs: Record<string, string>;
  readonly childNodes: FakeNode[] = [];
  parent: FakeNode | null = null;

  constructor(tag: string | null, attrs: Record<string, string> = {}, text: string | null = null) {
    if (tag === null) {
      this.nodeType = 3;
      this.nodeValue = text;
      this.attrs = {};
    } else {
      this.nodeType = 1;
      this.nodeValue = null;
      this.tagName = tag.toUpperCase();
      this.attrs = { ...attrs };
    }
  }

  append(...kids: Array<FakeNode | string>): this {
    for (const k of kids) {
      const node = typeof k === "string" ? new FakeNode(null, {}, k) : k;
      node.parent = this;
      this.childNodes.push(node);
    }
    return this;
  }

  get children(): FakeNode[] {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.nodeValue ?? "";
    return this.childNodes.map((n) => n.textContent).join("");
  }

  getAttribute(name: string): string | null {
    return Object.hasOwn(this.attrs, name) ? this.attrs[name] : null;
  }

  querySelector(selector: string): FakeNode | null {
    return this.find(selector, true)[0] ?? null;
  }

  querySelectorAll(selector: string): FakeNode[] {
    return this.find(selector, false);
  }

  private find(selector: string, firstOnly: boolean): FakeNode[] {
    const groups = parseSelectorList(selector);
    const out: FakeNode[] = [];
    const walk = (n: FakeNode): boolean => {
      for (const c of n.childNodes) {
        if (c.nodeType !== 1) continue;
        if (groups.some((g) => matchesChain(c, g))) {
          out.push(c);
          if (firstOnly) return true;
        }
        if (walk(c)) return true;
      }
      return false;
    };
    walk(this);
    return out;
  }
}

/** Build an element: el("div", { id: "x" }, child, "text", ...) */
export function el(tag: string, attrs: Record<string, string> = {}, ...kids: Array<FakeNode | string>): FakeNode {
  return new FakeNode(tag, attrs).append(...kids);
}

const selectorCache = new Map<string, Step[][]>();

function parseSelectorList(selector: string): Step[][] {
  let groups = selectorCache.get(selector);
  if (!groups) {
    groups = selector.split(",").map((s) => s.trim()).filter(Boolean).map(parseSelector);
    selectorCache.set(selector, groups);
  }
  return groups;
}

interface Compound {
  tag: string | null;
  id: string | null;
  classes: string[];
  attrs: Array<{ name: string; op: "" | "=" | "^=" | "*="; value: string }>;
}

interface Step {
  compound: Compound;
  /** Combinator that links this step to the one on its LEFT. */
  combinator: " " | ">" | null;
}

function parseCompound(text: string): Compound {
  const c: Compound = { tag: null, id: null, classes: [], attrs: [] };
  let rest = text;
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tagMatch) {
    c.tag = tagMatch[0].toUpperCase();
    rest = rest.slice(tagMatch[0].length);
  }
  const tokenRe = /#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:([\^*]?=)"([^"]*)")?\]/y;
  let pos = 0;
  while (pos < rest.length) {
    tokenRe.lastIndex = pos;
    const m = tokenRe.exec(rest);
    if (!m) throw new Error(`fake-dom: unsupported selector fragment ${JSON.stringify(text)}`);
    if (m[1]) c.id = m[1];
    else if (m[2]) c.classes.push(m[2]);
    else c.attrs.push({ name: m[3], op: (m[4] ?? "") as Compound["attrs"][number]["op"], value: m[5] ?? "" });
    pos = tokenRe.lastIndex;
  }
  return c;
}

function parseSelector(text: string): Step[] {
  const tokens = text.split(/\s*(>)\s*|\s+/).filter((t) => t !== undefined && t !== "");
  const steps: Step[] = [];
  let pendingCombinator: " " | ">" | null = null;
  for (const t of tokens) {
    if (t === ">") {
      pendingCombinator = ">";
      continue;
    }
    steps.push({ compound: parseCompound(t), combinator: steps.length === 0 ? null : (pendingCombinator ?? " ") });
    pendingCombinator = null;
  }
  return steps;
}

function matchesCompound(n: FakeNode, c: Compound): boolean {
  if (n.nodeType !== 1) return false;
  if (c.tag && n.tagName !== c.tag) return false;
  if (c.id && n.getAttribute("id") !== c.id) return false;
  if (c.classes.length > 0) {
    const have = (n.getAttribute("class") ?? "").split(/\s+/);
    if (!c.classes.every((k) => have.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = n.getAttribute(a.name);
    if (v === null) return false;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "*=" && !v.includes(a.value)) return false;
  }
  return true;
}

function matchesChain(n: FakeNode, steps: Step[]): boolean {
  const last = steps[steps.length - 1];
  if (!matchesCompound(n, last.compound)) return false;
  let node: FakeNode | null = n;
  for (let i = steps.length - 2; i >= 0; i--) {
    const step = steps[i];
    const rightCombinator = steps[i + 1].combinator;
    if (rightCombinator === ">") {
      node = node?.parent ?? null;
      if (!node || !matchesCompound(node, step.compound)) return false;
    } else {
      node = node?.parent ?? null;
      while (node && !matchesCompound(node, step.compound)) node = node.parent;
      if (!node) return false;
    }
  }
  return true;
}
