/**
 * Shared Discord test fixtures: the ids the fixture tests use and a message
 * factory, so each test file does not carry its own copy.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { DiscordMessage } from "../../src/plugins/transport/discord-dom.js";

/** A channel id and a guild id of the right shape. */
export const CH = "1520443442982031486";
export const G = "1210290974601773056";

/** Message `n` of a channel: ids ascend with `n`, so higher is newer. */
export function msg(n: number, extra: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: String(1_544_000_000_000_000_000n + BigInt(n)),
    channel_id: CH,
    author: "Alice",
    author_inherited: false,
    author_ref: null,
    timestamp: null,
    content: `m${n}`,
    reply_to: null,
    reply_label: null,
    reactions: [],
    attachments: [],
    embeds: [],
    links: [],
    edited: false,
    ...extra,
  };
}
