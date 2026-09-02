/**
 * Discord content is untrusted input. Every string the adapter reads out of
 * the page — message text, embeds, reply labels, author names, attachment
 * names and URLs, links, reaction emoji, the channel label — was written by
 * someone else and may carry prompt-injection or homoglyph tricks aimed at
 * whatever model reads the result.
 *
 * This module runs every string field through `@mcpaql/security`'s content
 * validator and reports what it found, per message and per field. It does
 * not change the messages unless asked (`redact`), and then it MASKS the
 * field: it never substitutes the validator's normalized text, which would
 * turn a homoglyph-disguised injection into a clean, working one. The flags
 * travel with the result so nothing is silently laundered.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ContentValidator } from "../../security/index.js";
import type { SecuritySeverity } from "../../security/types.js";
import type { DiscordMessage } from "./discord-dom.js";

export type UntrustedField =
  | "content"
  | "author"
  | "reply_label"
  | "link"
  | "reaction.emoji"
  | "embed.title"
  | "embed.description"
  | "embed.provider"
  | "embed.url"
  | "attachment.filename"
  | "attachment.url"
  | "channel.label";

export interface UntrustedFlag {
  /** Null for flags on the channel itself. */
  message_id: string | null;
  field: UntrustedField;
  /** Index within links/reactions/embeds/attachments, when the field is one of those. */
  index: number | null;
  severity: SecuritySeverity;
  patterns: string[];
}

export interface ClassifyOptions {
  /**
   * Mask flagged fields of `high` or `critical` severity with
   * {@link REDACTED}. Off by default: the flags are the signal, and a reader
   * may need the original to judge it.
   */
  redact?: boolean;
  /**
   * Longest prefix of a field that is scanned. Longer fields are scanned on
   * that prefix and additionally flagged `oversize_field`. Clamped to the
   * validator's own limit. The default is Discord's own message ceiling,
   * which also bounds the validator's cost on hostile input. @default 4096
   */
  maxFieldLength?: number;
}

export interface ClassifyResult {
  messages: DiscordMessage[];
  flags: UntrustedFlag[];
  /** Ids of messages with at least one flag. */
  flagged_ids: string[];
  highest_severity: SecuritySeverity | null;
}

/** What a redacted field becomes. A mask, never normalized attacker text. */
export const REDACTED = "[CONTENT_BLOCKED]";

/** The validator's hard limit on scanned text; longer input is never scanned. */
const VALIDATOR_MAX_LENGTH = 50_000;
/** Discord's message ceiling; bounds the validator's cost per field. */
export const DEFAULT_MAX_FIELD_LENGTH = 4096;

const SEVERITY_RANK: Record<SecuritySeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

interface Hit {
  severity: SecuritySeverity;
  patterns: string[];
}

const isUnicodeFinding = (p: string): boolean => /^Unicode:/i.test(p);
/** Unicode findings that hide text (invisible or direction-overriding characters), as opposed to merely mixing scripts. */
const isHidingFinding = (p: string): boolean => isUnicodeFinding(p) && /zero.?width|bidi|direction|invisible|override/i.test(p);

function scan(text: string | null, maxFieldLength: number): Hit | null {
  if (text === null || text === "") return null;
  const oversize = text.length > maxFieldLength;
  const probe = oversize ? text.slice(0, maxFieldLength) : text;
  const first = ContentValidator.validateAndSanitize(probe, { maxLength: maxFieldLength });
  const patterns = [...(first.detectedPatterns ?? [])];
  let severity: SecuritySeverity | null = first.isValid && patterns.length === 0 ? null : (first.severity ?? "low");

  // The validator tests injection patterns on the ORIGINAL text. When it
  // found Unicode tricks, scan its normalized form too, so a zero-width,
  // bidi, or homoglyph-obscured injection is reported as the injection it
  // is, not only as an anonymous Unicode finding.
  if (patterns.some(isUnicodeFinding) && first.sanitizedContent && first.sanitizedContent !== probe) {
    const second = ContentValidator.validateAndSanitize(first.sanitizedContent, { maxLength: maxFieldLength });
    for (const p of second.detectedPatterns ?? []) if (!isUnicodeFinding(p) && !patterns.includes(p)) patterns.push(p);
    if (second.severity && (severity === null || SEVERITY_RANK[second.severity] > SEVERITY_RANK[severity])) severity = second.severity;
  }

  // Mixed scripts alone are ordinary bilingual text (Cyrillic, Greek, CJK
  // with Latin). Report it, but never above `medium`, so it is never masked.
  // Findings that hide text keep their severity.
  if (severity !== null && patterns.every(isUnicodeFinding) && !patterns.some(isHidingFinding)) {
    severity = SEVERITY_RANK[severity] > SEVERITY_RANK.medium ? "medium" : severity;
  }

  if (oversize) {
    patterns.push("oversize_field");
    severity = severity !== null && SEVERITY_RANK[severity] > SEVERITY_RANK.medium ? severity : "medium";
  }
  return severity === null ? null : { severity, patterns };
}

/**
 * Classify every string field of every message. Pure: returns new message
 * objects, never mutates the input.
 */
export function classifyDiscordMessages(messages: readonly DiscordMessage[], options: ClassifyOptions = {}): ClassifyResult {
  const redact = options.redact ?? false;
  const maxFieldLength = Math.min(VALIDATOR_MAX_LENGTH, Math.max(1, Math.floor(options.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH)));
  const flags: UntrustedFlag[] = [];
  const out: DiscordMessage[] = [];
  let highest: SecuritySeverity | null = null;

  const note = (message_id: string | null, field: UntrustedField, index: number | null, hit: Hit): boolean => {
    flags.push({ message_id, field, index, severity: hit.severity, patterns: hit.patterns });
    if (highest === null || SEVERITY_RANK[hit.severity] > SEVERITY_RANK[highest]) highest = hit.severity;
    return redact && SEVERITY_RANK[hit.severity] >= SEVERITY_RANK.high;
  };

  for (const m of messages) {
    const copy: DiscordMessage = {
      ...m,
      links: [...m.links],
      reactions: m.reactions.map((r) => ({ ...r })),
      embeds: m.embeds.map((e) => ({ ...e })),
      attachments: m.attachments.map((a) => ({ ...a })),
    };
    /** Scan one field; when redacting, mask it through `set`. */
    const check = (field: UntrustedField, index: number | null, value: string | null, set: () => void): void => {
      const hit = scan(value, maxFieldLength);
      if (hit && note(m.id, field, index, hit)) set();
    };

    check("content", null, m.content, () => { copy.content = REDACTED; });
    check("author", null, m.author, () => { copy.author = REDACTED; });
    check("reply_label", null, m.reply_label, () => { copy.reply_label = REDACTED; });
    m.links.forEach((l, i) => check("link", i, l, () => { copy.links[i] = REDACTED; }));
    m.reactions.forEach((r, i) => check("reaction.emoji", i, r.emoji, () => { copy.reactions[i].emoji = REDACTED; }));
    m.embeds.forEach((e, i) => {
      check("embed.title", i, e.title, () => { copy.embeds[i].title = REDACTED; });
      check("embed.description", i, e.description, () => { copy.embeds[i].description = REDACTED; });
      check("embed.provider", i, e.provider, () => { copy.embeds[i].provider = REDACTED; });
      check("embed.url", i, e.url, () => { copy.embeds[i].url = REDACTED; });
    });
    m.attachments.forEach((a, i) => {
      check("attachment.filename", i, a.filename, () => { copy.attachments[i].filename = REDACTED; });
      check("attachment.url", i, a.url, () => { copy.attachments[i].url = REDACTED; });
    });
    out.push(copy);
  }

  return { messages: out, flags, flagged_ids: [...new Set(flags.map((f) => f.message_id).filter((id): id is string => id !== null))], highest_severity: highest };
}

/**
 * Classify a channel-level string (the list label, which a group DM's members
 * can rename). Returns the flag, or null when clean.
 */
export function classifyChannelLabel(label: string | null, options: ClassifyOptions = {}): { flag: UntrustedFlag | null; label: string | null } {
  const maxFieldLength = Math.min(VALIDATOR_MAX_LENGTH, Math.max(1, Math.floor(options.maxFieldLength ?? DEFAULT_MAX_FIELD_LENGTH)));
  const hit = scan(label, maxFieldLength);
  if (!hit) return { flag: null, label };
  const flag: UntrustedFlag = { message_id: null, field: "channel.label", index: null, severity: hit.severity, patterns: hit.patterns };
  const masked = (options.redact ?? false) && SEVERITY_RANK[hit.severity] >= SEVERITY_RANK.high;
  return { flag, label: masked ? REDACTED : label };
}
