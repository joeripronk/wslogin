# termd — own tmux/sudosh3-style reattachable terminal daemon

Plan for a new project (`github.com/joeripronk/termd`) that replaces the
tmux + server-side-replay architecture of wslogin. Working branch in the
wslogin repo: `wslogin-new-term`.

## Why

Current stack: wslogin-server spawns a per-session tmux server, attaches a
pty to it, and acts as a man-in-the-middle: it logs the *client stream*
tmux emits, keeps a headless mirror terminal, writes checkpoints from the
mirror, replays log+checkpoint on every reconnect, and dances resizes to
force tmux attribute fixes.

Structural problems:

1. **Scrollback loss.** tmux streams a *diff of the pane screen*, not the
   byte stream. Output bursts coalesced in one refresh cycle scroll lines
   off the top of the pane without ever reaching the client stream, so
   those lines are missing in the browser scrollback, in the session log
   and in checkpoints. Unfixable from the outside: tmux simply does not
   send them.
2. **Reconnect is server-mitM.** Reconnect correctness depends on log +
   checkpoint + replay terminals staying in sync with what the clients
   saw — three serialized copies of the same state, all derived from a
   lossy stream.
3. **Four resize refactors per reconnect** (reflow cost, duplication at
   the replay boundary, the ±1 dance / refresh-client patches).
 4. **Recording is a side effect** of proxying, not a first-class feature.

## Core idea

One per-user **session daemon** (`termd`) that *owns* the shell pty and is
the single source of truth:

- It runs the shell on a real pty (node-pty), feeds every raw byte into
  an embedded terminal emulator (`@xterm/headless`) that holds the
  authoritative screen + scrollback (e.g. 10000 lines).
- It **records the raw stream** — lossless by construction (no tmux in
  between, so problem 1 disappears).
- Any client that attaches gets: **snapshot** (serialize of current
  screen + scrollback, `@xterm/addon-serialize`) followed by the live
  byte stream. Reconnect is native: the daemon's RAM state *is* the
  history; no log replay, no checkpoints, no mirror.
- Clients: the wslogin browser page (wslogin-server becomes a thin
  websocket↔unix-socket proxy, auth stays there) and a CLI
  (`termd attach`, `termd list`, `termd kill`, `termd send`, `termd snap`)
  that reattaches from the command line without any server in the path.
- Multiple clients per session: one writer (owner), N view-only watchers
  (share links), same model as today.

The daemon replaces tmux, the mirror, the checkpoints, the replay
terminal and the resize dance. It is tmux minus copy-mode, plus
integrated recording.

## Design

### Components

| Piece | Role |
|-------|------|
| `termd` (daemon) | owns shell ptys + terminal models, records, serves clients |
| `termd` CLI | attach/list/kill/send/snap over the user's unix socket |
| wslogin-server | authentication (PAM/SSO/cookies) + websocket→unix-socket proxy only |
| www/wslogin.js | keeps working: same `\0`/`\1` framing, snapshot on attach |
| playback.js | keeps working: same JSONL log format, thumbnails from daemon |
| uploader/receiver | keeps working: uploads the same session logs |

### Stack

Node.js, reusing what wslogin already runs in production:
`node-pty`, `@xterm/headless`, `@xterm/addon-serialize`, the JSONL log
format, the `\0`-JSON / `\1`-raw framing. A terminal client (the CLI)
needs no emulator at all — it is a raw pty bridge.
(Alternative: Rust + `vte` for a lighter per-session footprint; not
needed for v1, wslogin already runs this stack.)

### Daemon lifecycle

- **One daemon per session**, no central daemon (no SPOF): the CLI
  spawns the session daemon detached; it listens on
  `$XDG_RUNTIME_DIR/termd/<id>.sock` and registers `<id>.meta` in the
  same directory. `list` scans the registry and probes each socket.
- A crashed session daemon kills exactly one session — the blast radius
  wslogin already accepts from per-session tmux servers today.
- The daemon survives wslogin-server restarts and browser disconnects
  (today's role of the per-session tmux server).
- Idle policy: kill a session after N days detached (config).
- Planned restarts/upgrades: the daemon owns the pty master fd, so a
  restart would SIGHUP the shell. v2 does zero-downtime upgrades by
  handing the pty master fd + session state to the new daemon over
  `SCM_RIGHTS` (the old daemon exits, clients reconnect to the new
  socket, shells never notice). v1 accepts per-session restarts.

### Socket & security

- Unix sockets at `$XDG_RUNTIME_DIR/termd/<id>.sock`, 0700, owned by the
  user. The CLI talks to them directly — **native reconnect, no server
  involved**.
- wslogin-server (service user) reaches it through a group/ACL
  (setfacl, same pattern as `/run/wslogin/tmux` today).
- wslogin-server authenticates (PAM/SSO/cookies, reconnect tokens) and
  forwards `attach <session> [owner|view]`. The daemon trusts the socket
  peer: connections from the wslogin proxy are tagged by a per-daemon
  proxy secret handed out at registration; direct CLI users are already
  uid-verified by SO_PEERCRED.
- Root is never involved.

### Wire protocol (unix socket + websocket, same framing as today)

Client → daemon: `\1<raw keystrokes>`; `\0{"cmd":...}` for
`attach|new|resize|detach|view|share|list|snapshot|kill`.
Daemon → client: on attach `\0{resize}` + `\1<serialized snapshot>` +
live `\1`/`\0{b64}` stream; `\0{exit}` on shell exit. Resize is owned by
the session (last owner wins, viewers mirror), same as today, minus the
±1 dance — the daemon redraws attributes from its own model, no repaint
needed.

### Recording

- One JSONL log per session, byte-identical format to today
  (`c:0` command, `c:1` output, `c:2` input, `c:3` exit) → playback.js,
  uploader/receiver and sudovideo keep consuming it unchanged.
- The log is written from the raw pty stream, so playback/replay is
  lossless.
- No checkpoint files: seeking in playback still needs random access →
  keep the playback-side checkpoint cache in playback.js (it already
  builds its own cache from logs). Live thumbnails come from the daemon
  (`termd snap` → serialize viewport only).

## Migration phases

1. **termd MVP** (new repo): daemon + CLI, single shell session, attach
   with snapshot, raw recording to the JSONL format, `list`/`kill`.
   Acceptance: `seq 1 41` bursts lose no lines in `termd snap` output.
2. **CLI parity**: picker, Ctrl-] detach, reconnect tokens replaced by
   "the daemon is always there" (wslogin-cli.js features move into
   `termd attach`).
3. **wslogin integration**: wslogin-server gains `termd` proxy mode
   (websocket ↔ unix socket, auth as today); browser client unchanged.
   Run tmux-mode and termd-mode side by side behind a config key.
4. **Playback/live**: thumbnail + live-session endpoints from the daemon;
   playback.js unchanged (logs are compatible).
5. **Cleanup in wslogin** (on this branch): drop tmux.conf, the mirror,
   checkpoints, `create_replayed_terminal`, `refresh-client`, the resize
   dedupe patches — all of it is superseded by daemon state.

## Open questions

- Scrollback *browsing* (tmux copy-mode replacement): v1 = browser
  scrollback only (snapshot carries it); a `termd scrollback <lines>`
  query for CLI later.
- Snapshot size on attach: cap the serialized scrollback sent to
  reconnecting clients (e.g. 2000 lines, matching today's constant).
- Daemon memory: @xterm/headless ≈ 1–2 MB per session at 10k scrollback;
  fine for wslogin's scale, reconsider (Rust) if sessions per host grow.
- Window management (multiple windows/panes): explicitly **out of
  scope** — wslogin never exposed them (prefix None); one shell per
  session, `termd new` for another session.
