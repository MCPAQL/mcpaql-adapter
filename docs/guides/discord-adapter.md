# Discord Adapter (read-only)

The Discord adapter reads your Discord conversations out of the Discord web client that is already open in your browser. That is the whole idea: it is a faster, structured copy-paste of a screen you already have in front of you. It reads. It never writes.

## What it is, and what it is not

- It is **not a bot**. Nothing is added to any server, and no server admin is involved.
- It holds **no token**. Not a bot token, not your user token, not an OAuth grant. There is no Discord developer account to create.
- It makes **no Discord API calls**. It reads the rendered page in your own browser, the same way select-all and copy does.
- It **never sends, reacts, edits, types, focuses an input, or clicks**. That is a tested property of the code, not a promise: every script the adapter runs in the page is registered with the side effects it declares, and a test fails if any script uses an input, network, storage, or navigation primitive it has not declared.

## Setup

Two steps.

1. Start Chrome with remote debugging enabled, then log in to Discord in that Chrome window.

   macOS:

   ```sh
   open -a "Google Chrome" --args --remote-debugging-port=9222
   ```

   Linux:

   ```sh
   google-chrome --remote-debugging-port=9222
   ```

   The port is the default the adapter looks for. Set `MCPAQL_CDP_PORT` to use another one. If the port is closed when the adapter starts, its error message prints the exact command for your platform.

2. Install the adapter and point your MCP client at it, like any other MCP-AQL adapter.

That is all. Keep the Discord tab open; it can be in the background, in another window, and unfocused. The adapter works with the tab hidden.

## The one side effect

Opening a channel marks it read in Discord, exactly as clicking it does. Nothing else in the adapter has any effect on your account or on what other people see.

## Discord's terms, plainly

Discord prohibits automating user accounts. This adapter does not use the Discord API, does not hold any credential, and never sends, reacts, or edits. It reads the rendered page in your own browser. You decide for yourself whether that is appropriate for your account.

## Operations

All operations are reads. Every listing and history result carries the bounded-scan envelope used across this repository, so a caller can always tell whether it got everything and where to resume.

| Operation | Parameters | Returns |
|---|---|---|
| `list_dms` | `limit` | Direct and group conversations: id, name, kind, presence, unread. Friends, Nitro, Shop, and message requests are excluded. |
| `list_guilds` | `limit` | Servers you belong to: id, name, and the raw sidebar label. |
| `list_channels` | `limit` | Text and voice channels of the open server with their category, plus the server's id and name. |
| `read_messages` | `channel_id`, `guild_id?`, `before?`, `limit`, `scan_cap`, `time_budget_ms` | Messages newest first with author, timestamp, full text, replies, reactions, attachment links, embeds, links, edited flag. |

`read_messages` envelope:

```text
{ channel, messages, count, scanned, cursor, complete, truncated, stop_reason, problem, elapsed_ms }
```

- `complete` is true when the beginning of the channel was reached or `limit` was filled.
- `truncated` is true when a cap or the time budget stopped the read first. The result then carries a `cursor`: pass it as `before` to continue without gaps or duplicates. The adapter never truncates silently.
- `stop_reason` says which of `filled`, `beginning`, `scan_cap`, `time_budget`, `no_growth`, or `problem` ended the read.

Attachments are returned as URLs and filenames only; nothing is downloaded.

## Untrusted content

Everything the adapter reads was written by someone else. Every text field, including author names, reply labels, embed text, and attachment names, is run through the repository's security validator. Prompt-injection and homoglyph findings are reported per message and per field with a severity. The text itself is not changed unless a caller asks for redaction, and then only for high or critical findings. The flags travel with the result so nothing is silently laundered.

## When Discord changes its markup

Discord hashes its class names and changes its page structure from time to time. The adapter selects elements by the stable attributes Discord uses for accessibility and navigation (`data-list-id`, element id prefixes, `role`, `datetime`) and keeps every selector in one table per module:

- `src/plugins/transport/discord-dom.ts` — messages
- `src/plugins/transport/discord-nav.ts` — sidebars and navigation
- `src/plugins/transport/discord-history.ts` — scrolling for history

Each table has fixture tests built from observed markup. When Discord changes something, one of those tests fails and names the selector, instead of the adapter quietly returning empty results. The fix is a selector edit in one place.

## How it works, briefly

- **Transport.** A read-only session over the Chrome DevTools Protocol to your already-running Chrome, using the WebSocket client built into Node. Exactly one protocol method is allowed, `Runtime.evaluate`; the allowlist is tested. The session is pinned to `https://discord.com`: the origin is checked inside every evaluation, so a tab that navigates away never runs a script.
- **Scripts.** Each page script is a self-contained function that is unit-tested in Node against a small fake DOM and shipped to the browser as its own source text. What the tests ran is what the page runs; a test transpiles the module the way the build does and proves the result runs in a bare context.
- **History.** Discord loads older messages when the list is scrolled to the top. The adapter nudges the real scroller, dispatches a synthetic scroll event (hidden tabs never render a native one), and polls from the Node side for the list to grow. All waiting happens in Node, because hidden tabs throttle in-page timers.
- **Navigation.** Opening a channel is a same-document route change, a history push plus the `popstate` event Discord's router handles, so the client is never reloaded. Paths are built only from validated snowflake ids; a caller-supplied URL never reaches the page.
