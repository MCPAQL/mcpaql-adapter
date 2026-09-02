# Discord Adapter (read-only)

The Discord adapter reads your Discord conversations out of the Discord web client that is already open in your browser. That is the whole idea: it is a faster, structured copy-paste of a screen you already have in front of you. It reads. It never writes.

## Status

The adapter ships as a runnable MCP server (`src/bin/discord.ts`, built to `dist/bin/discord.js`) over a library (`src/plugins/transport/`): the transport, the page scripts, the listing and history functions, the read-only and untrusted-content checks, the operation layer, and the configuration. A client configured as below can call `list_dms`, `list_guilds`, `list_channels`, and `read_messages` against a live Discord tab. Search through the in-client search box is not implemented (tracked separately); direct messages and channels do not need it.

## What it is, and what it is not

- It is **not a bot**. Nothing is added to any server, and no server admin is involved.
- It holds **no token**. Not a bot token, not your user token, not an OAuth grant. There is no Discord developer account to create.
- It makes **no Discord API calls**. It reads the rendered page in your own browser, the same way select-all and copy does.
- It **never sends, reacts, edits, types, focuses an input, or clicks**. That is a tested property of the code, not a promise: every script the adapter runs in the page is registered with the side effects it declares, and a test fails if any script uses an input, network, storage, or navigation primitive it has not declared.

## Setup

1. Start Chrome with remote debugging enabled and a separate profile directory, then log in to Discord in that Chrome window.

   Chrome 136 and later open the debugging port only when `--user-data-dir` points somewhere other than the default profile, so the command uses a dedicated directory. That profile has its own logins: sign in to Discord there once. This is a second Chrome instance (on macOS, `open -n` is what makes it one; without it a running Chrome is only brought to the front and the flags never reach a process), so your normal Chrome can stay open.

   macOS:

   ```sh
   open -n -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.mcpaql/chrome-debug"
   ```

   Linux:

   ```sh
   google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.mcpaql/chrome-debug"
   ```

   The transport connects to `127.0.0.1:9222` unless its `port` option says otherwise. When the port is closed, the error message includes both commands above.

2. Run the adapter from this repository and point your MCP client at it. It speaks MCP over stdio.

   ```sh
   npm install
   npm run build          # produces dist/bin/discord.js
   ```

   Claude Code:

   ```sh
   claude mcp add discord -- node /path/to/mcpaql-adapter/dist/bin/discord.js
   ```

   Any client that takes a JSON server entry:

   ```json
   {
     "mcpServers": {
       "discord": {
         "command": "node",
         "args": ["/path/to/mcpaql-adapter/dist/bin/discord.js"],
         "env": { "MCPAQL_CDP_PORT": "9222" }
       }
     }
   }
   ```

   During development, `npm run discord` (or `npx tsx src/bin/discord.ts`) runs the same entry point without a build.

3. Configuration is three environment variables; unset means the default. A set value that is invalid is refused by name at startup (exit code 2), never silently defaulted.

   | Variable | Default | Meaning |
   |---|---|---|
   | `MCPAQL_CDP_PORT` | `9222` | The `--remote-debugging-port` you gave Chrome. |
   | `MCPAQL_CDP_HOST` | `127.0.0.1` | Loopback only (`127.0.0.1`, `localhost`, `::1`). The adapter never attaches to a browser on another machine. |
   | `MCPAQL_CDP_TIMEOUT_MS` | `10000` | Bound on each DevTools call. |

   The origin is fixed at `https://discord.com`. The result size cap of the transport (10 MiB per evaluation) is not configurable; `read_messages` stays well under it by default.

At startup the adapter prints one line to stderr saying where it will look, then probes the port once (bounded to 3 s, after the MCP handshake, so your client never waits on Chrome). A closed port prints the launch commands; an open port with no attachable Discord tab prints why. The server serves either way, and every call returns the same named error until Chrome is up.

Keep the Discord tab open. It can be in the background, in another window, and unfocused: the adapter works with the tab hidden.

## The one side effect

Opening a channel marks it read in Discord, exactly as clicking it does. Nothing else in the adapter has any effect on your account or on what other people see.

## Discord's terms, plainly

Discord prohibits automating user accounts. This adapter does not use the Discord API, does not hold any credential, and never sends, reacts, or edits. It reads the rendered page in your own browser. You decide for yourself whether that is appropriate for your account.

## Operations

All operations are reads, served by one MCP tool, `mcp_aql_read`, which is annotated read-only. Call it with `{ operation, params }`:

```javascript
{ operation: "list_dms", params: { limit: 50 } }
{ operation: "read_messages", params: { channel_id: "1520443442982031486", limit: 100 } }
{ operation: "introspect", params: { query: "operations", name: "read_messages" } }
```

Every answer is the MCP-AQL envelope as JSON text: `{ success: true, data }` or `{ success: false, error: { code, message, details } }`. A failure is always an envelope, never a transport-level error: an unknown operation is `NOT_FOUND_OPERATION`, a missing or malformed parameter is `VALIDATION_MISSING_PARAM` or `VALIDATION_INVALID_TYPE`, an unknown parameter is `VALIDATION_UNKNOWN_PARAM` (a misspelled `chanel_id` cannot silently read the wrong thing), a closed port is `TRANSPORT_CDP_PORT_CLOSED` with the launch commands in the message, and a channel that never opens is `NOT_FOUND_RESOURCE`. `introspect` with `query: "operations"` lists every operation; with a `name` it returns that operation's parameters, defaults, and bounds; `query: "types"` describes the result shapes.

Operations run one at a time, in arrival order: two reads at once would fight over the one Discord tab.

| Operation | Function | Parameters | Returns |
|---|---|---|---|
| `list_dms` | `listDms` via `buildListExpression("listDms")` | `limit` (200) | Direct and group conversations: id, name, kind, presence, unread. Friends, Nitro, Shop, and message requests are excluded. |
| `list_guilds` | `listGuilds` via `buildListExpression("listGuilds")` | `limit` (200) | Servers you belong to: id, name, and the raw sidebar label. |
| `list_channels` | `listChannels` via `buildListExpression("listChannels")` | `limit` (200) | Text and voice channels of the server currently open in the tab with their category, plus the server's id and name. To read another server, open it in the Discord tab first; it is your screen. |
| `read_messages` | `readMessages` | `channel_id` (required), `guild_id`, `before`, `limit` (50), `scan_cap` (2000), `time_budget_ms` (20000), `window_max_bytes` (4 MiB), `redact` (false) | Messages newest first with author, timestamp, full text, replies, reactions, attachment links, embeds, links, edited flag. |

Integer parameters outside their bounds are clamped, not refused; `introspect` reports the bounds.

The three listings return `{ items, count, truncated, problem }`. They read what the sidebar shows at that moment; `truncated` means `limit` cut the list, and there is no cursor: raise `limit` and call again.

`read_messages` returns:

```text
{ channel, messages, count, scanned, cursor, complete, truncated, stop_reason, problem, elapsed_ms, flags, flagged_ids, highest_severity }
```

- `complete` is true when `limit` was filled or the beginning of the channel was reached (two consecutive scroll steps with no older history mounting and no loading placeholder above the rows).
- `truncated` is the opposite of `complete`: a cap, the time budget, a stall, or a problem stopped the read first. `stop_reason` says which: `filled`, `beginning`, `scan_cap`, `time_budget`, `no_growth`, or `problem`.
- `cursor` is where to continue: the oldest message returned, or, when an incomplete read returned nothing older than `before`, `before` itself. It is null only when the read was complete and returned nothing, or when an incomplete read returned nothing and had no `before`. Pass it as `before` to continue without gaps or duplicates. The adapter never truncates silently.
- `flags`, `flagged_ids`, `highest_severity` are the untrusted-content findings described below.

Attachments are returned as URLs and filenames only; nothing is downloaded.

## Untrusted content

Everything the adapter reads was written by someone else. Every string field, including author names, reply labels, embed text and URLs, attachment names and URLs, links, reaction emoji, and the channel label, is run through the repository's security validator. Prompt-injection and homoglyph findings are reported per message and per field with a severity. Text that only mixes scripts, as bilingual messages do, is reported at most `medium` and never masked. The text itself is not changed unless `redact` is set, and then a `high` or `critical` field is replaced by a mask, never by normalized text. The flags travel with the result so nothing is silently laundered.

## When Discord changes its markup

Discord hashes its class names and changes its page structure from time to time. The adapter prefers the stable attributes Discord uses for accessibility and navigation (`data-list-id`, element id prefixes, `role`, `datetime`), and where no such attribute exists it matches the un-hashed stem of a class name (`reaction_`, `embed`, `edited`, `scroller`, the loading placeholder). Those stem matches are the selectors most likely to break. Every selector lives in one table per module:

- `src/plugins/transport/discord-dom.ts` — messages
- `src/plugins/transport/discord-nav.ts` — sidebars and navigation
- `src/plugins/transport/discord-history.ts` — scrolling for history

Each table has fixture tests built from observed markup. When Discord changes something, one of those tests fails and names the selector, instead of the adapter quietly returning empty results. The fix is a selector edit in one place.

## How it works, briefly

- **Server.** One MCP tool over stdio, `mcp_aql_read`, dispatching by operation name to the operation layer (`discord-operations.ts`): schema-driven parameter validation, the `{ success, data | error }` envelope, and introspection. The server never writes to stdout except MCP; setup and probe messages go to stderr.
- **Transport.** A read-only session over the Chrome DevTools Protocol to your already-running Chrome, using the WebSocket client built into Node. Exactly one protocol method is allowed, `Runtime.evaluate`; the allowlist is tested. The session is pinned to `https://discord.com`: the origin is checked inside every evaluation, so a tab that navigates away never runs a script.
- **Scripts.** Each page script is a self-contained function that is unit-tested in Node against a small fake DOM and shipped to the browser as its own source text. What the tests ran is what the page runs; a test transpiles the module the way the build does and proves the result runs in a bare context.
- **History.** Discord loads older messages when the list is scrolled to the top. The adapter nudges the real scroller, dispatches a synthetic scroll event (hidden tabs never render a native one), and polls from the Node side for the list to grow. All waiting happens in Node, because hidden tabs throttle in-page timers.
- **Navigation.** Opening a channel is a same-document route change, a history push plus the `popstate` event Discord's router handles, so the client is never reloaded. Paths are built only from validated snowflake ids; a caller-supplied URL never reaches the page.
