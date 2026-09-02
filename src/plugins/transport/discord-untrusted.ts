/**
 * Discord content is untrusted input. Every string the adapter reads out of
 * the page — message text, embeds, reply labels, author names, attachment
 * names — was written by someone else and may carry prompt-injection or
 * homoglyph tricks aimed at whatever model reads the result.
 *
 * This module runs each field through `@mcpaql/security`'s content
 * validator and reports what it found, per message and per field. It does
 * not change the messages unless asked (`redact`): the caller decides
 * whether to pass flagged text along, mask it, or drop it. Either way the
 * flags travel with the result so nothing is silently laundered.
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
  | "embed.title"
  | "embed.description"
  | "embed.provider"
  | "attachment.filename";

export interface UntrustedFlag {
  message_id: string;
  field: UntrustedField;
  /** Index within embeds/attachments, when the field is one of those. */
  index: number | null;
  severity: SecuritySeverity;
  patterns: string[];
}

export interface ClassifyOptions {
  /**
   * Replace flagged text of `high` or `critical` severity with the
   * validator's sanitized form. Off by default: the flags are the signal,
   * and a reader may need the original to judge it.
   */
  redact?: boolean;
  /** Longest single field considered; longer fields are flagged as oversize instead of scanned. @default 20000 */
  maxFieldLength?: number;
}

export interface ClassifyResult {
  messages: DiscordMessage[];
  flags: UntrustedFlag[];
  /** Ids of messages with at least one flag. */
  flagged_ids: string[];
  highest_severity: SecuritySeverity | null;
}

const SEVERITY_RANK: Record<SecuritySeverity, number> = { low: 1, medium: 2, high: 3, critical: 4 };

function scan(text: string | null, maxFieldLength: number): { severity: SecuritySeverity; patterns: string[]; sanitized: string } | null {
  if (text === null || text === "") return null;
  if (text.length > maxFieldLength) {
    return { severity: "medium", patterns: ["oversize_field"], sanitized: text.slice(0, maxFieldLength) };
  }
  const r = ContentValidator.validateAndSanitize(text, { skipSizeCheck: true });
  const patterns = r.detectedPatterns ?? [];
  if (r.isValid && patterns.length === 0) return null;
  return { severity: r.severity ?? "low", patterns, sanitized: r.sanitizedContent ?? text };
}

/**
 * Classify every text field of every message. Pure: returns new message
 * objects when redacting, never mutates the input.
 */
export function classifyDiscordMessages(messages: readonly DiscordMessage[], options: ClassifyOptions = {}): ClassifyResult {
  const redact = options.redact ?? false;
  const maxFieldLength = options.maxFieldLength ?? 20_000;
  const flags: UntrustedFlag[] = [];
  const out: DiscordMessage[] = [];
  let highest: SecuritySeverity | null = null;

  const note = (message_id: string, field: UntrustedField, index: number | null, hit: NonNullable<ReturnType<typeof scan>>): void => {
    flags.push({ message_id, field, index, severity: hit.severity, patterns: hit.patterns });
    if (highest === null || SEVERITY_RANK[hit.severity] > SEVERITY_RANK[highest]) highest = hit.severity;
  };
  const shouldRedact = (hit: NonNullable<ReturnType<typeof scan>>): boolean => redact && SEVERITY_RANK[hit.severity] >= SEVERITY_RANK.high;

  for (const m of messages) {
    const copy: DiscordMessage = { ...m, embeds: m.embeds.map((e) => ({ ...e })), attachments: m.attachments.map((a) => ({ ...a })) };

    const content = scan(m.content, maxFieldLength);
    if (content) { note(m.id, "content", null, content); if (shouldRedact(content)) copy.content = content.sanitized; }

    const author = scan(m.author, maxFieldLength);
    if (author) { note(m.id, "author", null, author); if (shouldRedact(author)) copy.author = author.sanitized; }

    const reply = scan(m.reply_label, maxFieldLength);
    if (reply) { note(m.id, "reply_label", null, reply); if (shouldRedact(reply)) copy.reply_label = reply.sanitized; }

    m.embeds.forEach((e, i) => {
      const title = scan(e.title, maxFieldLength);
      if (title) { note(m.id, "embed.title", i, title); if (shouldRedact(title)) copy.embeds[i].title = title.sanitized; }
      const description = scan(e.description, maxFieldLength);
      if (description) { note(m.id, "embed.description", i, description); if (shouldRedact(description)) copy.embeds[i].description = description.sanitized; }
      const provider = scan(e.provider, maxFieldLength);
      if (provider) { note(m.id, "embed.provider", i, provider); if (shouldRedact(provider)) copy.embeds[i].provider = provider.sanitized; }
    });

    m.attachments.forEach((a, i) => {
      const filename = scan(a.filename, maxFieldLength);
      if (filename) { note(m.id, "attachment.filename", i, filename); if (shouldRedact(filename)) copy.attachments[i].filename = filename.sanitized; }
    });

    out.push(copy);
  }

  return {
    messages: out,
    flags,
    flagged_ids: [...new Set(flags.map((f) => f.message_id))],
    highest_severity: highest,
  };
}
