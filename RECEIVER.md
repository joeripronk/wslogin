# Receiver

This document describes the upload feature of wslogin and the protocol for the
server that receives the uploads. The uploader is implemented in `uploader.js`
and the receiver in `receiver.js`, both enabled through the
configuration file. The uploader runs as its own process, separate from
`server.js`, so uploading can never block or crash terminal sessions.

## Purpose

wslogin keeps a session log for every interactive terminal session in
`session_dir`. The uploader ships those logs to a central receiver so sessions
can be inspected or restored from another machine, even when the wslogin host
is gone. Active sessions are uploaded as near-real-time snapshots triggered by
a file monitor; finished sessions are uploaded once more as their final copy.
Checkpoints are local-only and are not uploaded.

Uploads are best effort and asynchronous. They must never block, slow down or
break a terminal session. Failed uploads are retried and finally dropped.

## Identity

Every upload belongs to a host, identified by:

| Field      | Required | Source                     | Description                              |
|------------|----------|----------------------------|------------------------------------------|
| `hostname` | yes      | `upload_hostname` / system | name of the wslogin host                 |
| `hostkey`  | no       | `upload_hostkey`           | secret that identifies this host instance |

`hostname` alone is not unique: a host can be renamed, reinstalled or two hosts
can share a name. `hostkey` is an optional long random secret that lets the
server distinguish them and authenticate the sender. Both values are supplied
by the wslogin administrator, not derived from the session.

The session itself is identified by `username` + `sessioncookie` (the UUID
wslogin uses internally). These are always included.

## Client configuration

```ini
upload_enabled=false
upload_url=wss://uploads.example.com/upload
upload_hostname=shell.example.com
upload_hostkey=
upload_interval_seconds=60
upload_active_enabled=true
upload_remove_uploaded=false
upload_connections=4
upload_high_water_bytes=1048576
upload_ca=/etc/wslogin/upload-ca.pem
upload_debug=false
upload_append_verbose=false
```

- `upload_enabled` defaults to `false`.
- `upload_url` is required when uploads are enabled; `ws` and `wss` are
  supported. `http`/`https` are accepted as aliases and mapped to `ws`/`wss`.
- `upload_interval_seconds` is the fallback rescan interval. Changes are
  normally detected by a recursive file monitor, so this only recovers from
  missed filesystem events. Defaults to `60`.
- `upload_active_enabled` uploads snapshots of sessions that are still running.
  Defaults to `true`; finished logs are always uploaded. Snapshots are
  event-driven: a recursive file monitor triggers a scan as soon as a log
  changes, uploads of one session are serialized, and changes that arrive
  during an upload are coalesced into the next snapshot, so a session is
  uploaded as soon as new output is ready and the previous upload has finished
  and an older snapshot can never overwrite a newer one on the receiver.
- `upload_remove_uploaded` removes a finished session log and its checkpoint
  after it has been uploaded successfully instead of renaming the log to
  `.uploaded`. Defaults to `false`. Active logs are never removed.
- `upload_connections` is the maximum number of WebSocket connections. Defaults
  to `4`.
- `upload_high_water_bytes` is the send buffer size at which a connection is
  considered saturated and another connection is opened. Defaults to `1048576`
  (1 MiB). The low water mark is a quarter of this value.
- `upload_hostname` defaults to `os.hostname()`.
- `upload_hostkey` is optional and sent verbatim.
- `upload_ca` is an optional PEM bundle used to verify the server certificate
  (for private CAs). It is not a way to disable verification.
- `upload_debug` logs every upload and retry to stdout. Defaults to `false`,
  which logs only rejections and errors.
- `upload_append_verbose` controls the verbosity of the receiver's state answers
  used during incremental append. Defaults to `false`: the receiver appends by
  default and only reports a state for a full match, an empty store, a pointer
  mismatch, or a stale append. `true` makes it answer every announce with its
  full state. Append itself is always enabled; this switch only changes how much
  the receiver talks. It is read on both the uploader and the receiver and must
  match on both.

## Receiver configuration

```ini
receiver_port=9023
receiver_data_dir=uploads
receiver_max_size=67108864
receiver_require_hostkey=false
receiver_active_template=active/<hostname>/<username>/<session>.json
receiver_store_template=archive/<%date YYYY-mm-dd>/<hostname>/<username>/<session>.json
receiver_debug=false
upload_append_verbose=false
```

- `receiver_port` is the port `receiver.js` listens on. Defaults to
  `9023`.
- `receiver_data_dir` is where received logs and metadata are stored.
  Relative paths are resolved against the directory of the server. Defaults to
  `uploads`.
- `receiver_max_size` is the largest accepted log in bytes. Defaults to
  64 MiB.
- `receiver_require_hostkey` rejects hosts that have no stored hostkey hash.
  Defaults to `false`.
- `receiver_active_template` is the layout of a session that is still running,
  relative to `receiver_data_dir`. Defaults to
  `active/<hostname>/<username>/<session>.json`. For compatibility, a
  `session_template` containing `<hostname>` is used when
  `receiver_active_template` is not set.
- `receiver_store_template` is the archive path of a completed session relative
  to `receiver_data_dir`. It supports `<hostname>`, `<username>`, `<session>`,
  `<kind>` and `<%date FORMAT>`, where `FORMAT` uses `YYYY`, `YY`, `mm` (month),
  `dd` (day), `HH`, `MM` (minutes) and `ss`. The date is the session start date from the first log
  record. It must end in `.json`; the default is
  `archive/<hostname>/<username>/<session>.json`.
- `receiver_debug` logs every state reply and stored upload to stdout. Defaults
  to `false`, which logs only connections, errors and corrupt copies.
- `upload_append_verbose` controls how much the receiver talks during
  incremental append. Defaults to `false`: it appends by default and reports a
  state only for a full match, an empty store, a pointer mismatch, or a stale
  append. `true` answers every announce with the full state. Append is always
  enabled; this switch only changes verbosity and must match the uploader's.
- TLS is controlled by the shared `[https]` section. When enabled, the server
  serves `wss` (and `ws` too, unless `allow_http` is disabled).

To use hostkeys, store the SHA-256 of the accepted key for a host:

```bash
mkdir -p uploads/<hostname>
printf '%s\n' "$(printf '%s' '<hostkey>' | sha256sum | cut -d' ' -f1)" \
  > uploads/<hostname>/hostkey.hash
```

### Finished-session signal

`server.js` writes a session log while it is running, at the path produced by
`session_template` (default `<username>/<sessioncookie>.json`, relative to
`session_dir`). When the session ends, `server.js` renames the log to add a
`.done` suffix:

```text
<sessioncookie>.json.done
```

While a session is running the uploader monitors the `.json` log and uploads a
new snapshot as soon as it changes and the previous upload of that session has
finished. The receiver stores these snapshots in the
`receiver_active_template` layout. Snapshots are consistent prefixes: the size
is fixed before hashing and sending, so bytes appended during the transfer are
picked up by the next snapshot. Active logs are not renamed.

Once the session is finished and the log has the `.done` suffix, the uploader
uploads the final copy marked `finished:true`. The receiver writes it to the
`receiver_store_template` archive layout and removes the active copy, so a
completed session never stays in the active directory. The uploader then
renames the log from `.done` to `.uploaded`:

```text
<sessioncookie>.json.uploaded
```

With `upload_remove_uploaded=true` the finished log and its
`<sessioncookie>.checkpoint.json` are removed instead of renamed, freeing the
disk space as soon as the upload has succeeded.

Checkpoints (`<sessioncookie>.checkpoint.json`) are only used locally for
reconnects and are **not** uploaded.

Renaming (or removing) the log prevents the same finished session from being
uploaded again after the uploader restarts. `.uploaded` files are ignored by
both the uploader and `server.js`.

Files are hashed and uploaded as streams, so large logs are not read into
memory. Size and SHA-256 are computed in a streaming pass, then the file is sent
over the socket in 128 KiB binary frames with backpressure, which keeps memory
use constant.

Several uploads can be in flight at once and are multiplexed (interleaved) over
a single WebSocket connection. If the receiver cannot keep up, the uploader's
send buffer grows past `upload_high_water_bytes`, the connection is marked
saturated and an additional connection is opened, up to `upload_connections`, so
the remaining uploads are spread across connections. Connections are persistent
and shared between scans.

Uploads are retried without blocking the scan loop. A file whose SHA-256 was
already uploaded for the same session is not sent again. This local knowledge is
only trusted while the connection to the receiver is up: when the last live
connection is lost the uploader reconnects, forgets what it thought the receiver
had and re-announces every present log, so the receiver's true state is
re-synced (an intact copy is confirmed in a single roundtrip, a missing or
damaged one is uploaded again).

The same resync closes the loop in the other direction: every completed scan
ends with a full `list` of the local sessions and the uploader signals `gone`
for sessions a scan no longer finds, so the receiver archives active snapshots
of sessions that are gone on the sender as deleted sessions (see Protocol §5).
Finished archives stay untouched. Hosts that announce at least one session
resync fully; a host whose sessions all vanished while it was offline is only
cleaned once it announces sessions again (§5).

## Running

The uploader is a standalone executable:

```bash
node uploader.js                 # watch session_dir and upload changes
node uploader.js --once          # upload one snapshot of each log, then exit
node receiver.js                 # run the receiver
```

Both read the same configuration file (`WSLOGIN_CONFIG`, default
`/etc/wslogin/config.ini`); the uploader uses the same `session_dir` as
`server.js`. It must be able to
read the session files and rename (or, with `upload_remove_uploaded`, remove)
them inside `session_dir` after uploading, so run it as a user that has write
access to that directory.

Example systemd unit:

```ini
[Unit]
Description=wslogin uploader
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/wslogin/uploader.js
Restart=always
User=wslogin

[Install]
WantedBy=multi-user.target
```

## Protocol

Uploads use one or more WebSocket connections to `upload_url`. Each connection
carries one or more **streams** (uploads) that may be interleaved: frames for
different streams can follow each other in any order on the same connection.
Every stream is assigned a numeric id by the uploader, unique per connection.
All control messages are UTF-8 JSON text frames; file data is sent as binary
frames so it is never base64 encoded.

A connection is opened lazily and reused for later uploads. The server must
therefore keep per-connection stream state and must not assume one upload per
connection. Uploads on different connections are fully independent.

### 1. Announce

A stream starts with a JSON text frame, which may be sent at any time after the
connection is open:

```json
{
  "type": "upload",
  "id": 7,
  "hostname": "shell.example.com",
  "hostkey": "<secret>",
  "username": "joeri",
  "session": "2f1c...",
  "kind": "log",
  "size": 123456,
  "sha256": "9f86d0818...",
  "offset": 100000,
  "startdate": 1761177600,
  "finished": false
}
```

| Field      | Required | Description                                     |
|------------|----------|-------------------------------------------------|
| `type`     | yes      | `upload`                                        |
| `id`       | yes      | stream id, unique within the connection         |
| `hostname` | yes      | host identifier                                 |
| `hostkey`  | no       | omitted when not configured                     |
| `username` | yes      | system user owning the session                  |
| `session`  | yes      | sessioncookie (UUID) of the session             |
| `kind`     | yes      | always `log`                                    |
| `size`     | yes      | file size in bytes                              |
| `sha256`   | yes      | lowercase hex SHA-256 of the whole file         |
| `offset`   | no       | file pointer: bytes the server is expected to already have; `0` for a finished log or first snapshot |
| `startdate`| no       | session start, seconds since the epoch          |
| `finished` | no       | `false` for an active snapshot, default `true`  |

### 2. State and integrity check

In response to the announce the server reports the state of the file it stores
for `hostname/username/session`. Append is the default: when the stored size
equals the announced `offset` the server appends the tail the uploader streams,
and it does **not** have to confirm the append. It only reports when things go
wrong. The uploader asks for the state at most once per file:

```json
{"type": "state", "id": 7, "exists": true, "size": 123456, "sha256": "9f86d0818...", "finished": false, "synced": true}
{"type": "state", "id": 7, "exists": false}
{"type": "state", "id": 7, "exists": true, "size": 100000, "sha256": "3a7f...", "finished": false}
```

The server replies with a state in these cases:

- **full match** (stored `size` and `sha256` equal the announce, and a
  `finished:true` announce matches a finished copy): `synced:true`; the stream
  is complete, no data is transferred and there is no second roundtrip.
- **nothing stored**: `exists:false`. The uploader streams the whole file.
- **stored size differs from the announced `offset`**: `exists:true` with the
  server's real `size`. Because the size does not match the pointer, the
  uploader falls back to a full upload (a `replace`, or a `corrupt` for a
  differing finished copy).
- **stored size equals the announced `offset`** (an active log): the normal
  append. The server stays **silent** (no state reply); it seeds the stored
  prefix, appends the tail and verifies the full `sha256` on `end`. A prefix
  that turns out stale is caught on `end` and reported as a go-wrong size, so
  the uploader re-sends in full.

`verbose` mode (`upload_append_verbose=true`) makes the server answer every
announce with its full state (`exists`, `size`, `sha256`, `finished`, and
`synced` on a match), including a confirmation for the append case. The default
(`false`) is the terse behavior above: the server only speaks up for a full
match, an empty store, a pointer mismatch, and a stale append. The switch is
read on both sides and only controls verbosity; append itself is always enabled.

This lets the uploader verify the receiver with a single state query before
sending and lets a receiver whose copy is damaged ask for a fresh copy. A
damaged finished log is kept as `<sessioncookie>.corrupt` rather than being
overwritten; active snapshots replace each other. The file pointer is dropped
when the connection to the receiver is re-established, so a resync re-verifies
the receiver's real size.

### 3. Data

The session log (`<sessioncookie>.json`) is sent as binary frames. For a full
upload this is the whole file; for an append it is only the bytes after the
announced `offset`. Each binary frame is prefixed with the 4 byte big endian
stream id:

```text
+----------------+-----------------------------+
| id (4 bytes BE)| file data (128 KiB max)     |
+----------------+-----------------------------+
```

The server strips the 4 byte prefix, looks up the stream and writes the data to
that stream's temporary file. For an append it first seeds the temporary file
with the stored prefix, so the appended tail forms the complete file. Frames of
different streams may be interleaved in any order; per stream the order is
preserved. The uploader sends 128 KiB per frame, so a frame boundary has no
meaning.

The log is a sequence of JSON objects, one per line. Line format (internal, may
evolve):

```json
{"t":1698000000.0,"d":"...","c":0}
```

`c` is the record type: `0` command, `1` terminal output, `2` user input,
`3` mouse pointer, `4` session header, `5` tailer. `t` is a Unix timestamp and
`d` the payload. The first line of every log is the header record (`c:4`); its
payload carries `viewid`, `shareid`, `viewurl` and `shareurl`, the viewonly and
shared links of the wslogin host. When sessions run under tmux (`session_tmux`)
it also carries reconnect meta: `username`, `sessioncookie`, `reconnectid`,
`cols`, `rows`, `starttime` and the `tmux` server socket, which the server reads
at startup to re-attach live sessions after a restart. The last line of a
finished log is the tailer record (`c:5`); its payload carries `size` and
`sha256` of the log without the tailer itself plus the session `endtime`, so a
finished log is self-verifying. `wslogin` appends the tailer when a session ends and, at
startup, fixes finished logs that predate it. The receiver stores the log
as-is; the playback server reads the header from the file to offer live stream
and live control links in sudovideo. These URLs grant live access to the
terminal and must be treated as secrets.

The uploader sends the **whole file** for a finished log and for an active
snapshot whose file pointer does not match the receiver's stored size. When the
pointer matches, an active snapshot sends only the bytes after it. The receiver
treats the upload as a snapshot and replaces the stored log for
`hostname/username/session` atomically.

### 4. End and confirmation

A JSON text frame closes a stream that sent data:

```json
{"type": "end", "id": 7}
```

The server then verifies the received size and SHA-256 and replies with a JSON
text frame that echoes the stream id:

```json
{"type": "ok", "id": 7}
```

or an error:

```json
{"type": "error", "id": 7, "message": "bad hostkey", "retryable": false}
```

`retryable` defaults to `true` when omitted. The client keeps the connection
open after a stream is confirmed and closes it when shutting down.

### 5. Prune (gone and list)

Active snapshots are strays once the session log no longer exists on the
uploader host (cleaned up, removed after upload, deleted while the host was
offline). Two id-less JSON control messages keep the receiver's active
directory in sync; both carry `hostname` and, where hostkeys are used, the
`hostkey`:

```json
{"type": "gone", "hostname": "host", "username": "joeri", "session": "<uuid>"}
{"type": "list", "hostname": "host", "sessions": [{"username": "joeri", "session": "<uuid>"}, ...], "last": true}
```

`gone` reports a single session whose log was removed locally. `list` carries
the complete set of sessions the host currently has on disk; the receiver
prunes every active copy of that host not listed. A large list is split into
chunks on one connection; the receiver accumulates them and prunes when the
chunk with `"last": true` arrives. An empty list is ignored, so a scan that
finds nothing (unmounted `session_dir`, config change) cannot archive a
host's whole active directory. The uploader sends `gone` when a scan finds a
session that the previous scan still had, and sends the full `list` after
every completed scan, so a (re)connect resyncs the receiver as long as the
host keeps at least one session: when a host's sessions all disappear while
it is offline, the first list after reconnect is empty and ignored, and the
receiver's strays for that host are only pruned once it announces sessions
again.

Pruning only affects **active** copies and is scoped to the announcing
hostname. A pruned copy is not deleted: the receiver moves it to the archive
layout and appends a tailer record (`c:5`) whose payload carries the size,
SHA-256 and end time plus `"note": "deleted session"`, so the last snapshot
of a cleaned-up session stays available as a finished record. When the
finished copy of that session is already archived, the stale active copy is
discarded instead. Finished archives are never rewritten. Messages without a
valid hostname/username/session or a rejected hostkey are ignored. There is
no reply.

## Responses

| Reply                                          | Meaning                                 |
|------------------------------------------------|-----------------------------------------|
| `{"type":"state","id":N,...,"synced":true}`    | announce matches; stream is done, no data |
| `{"type":"state","id":N,...}`                  | reply to an announce, see above         |
| `{"type":"ok","id":N}`                         | stored; uploader marks uploaded          |
| (no reply for a non-verbose append)            | pointer honored; tail is appended       |
| `{"type":"error","id":N,...,"retryable":false}`| rejected; dropped, no retry             |
| `{"type":"error","id":N,...}` / dropped socket | that stream is retried with backoff     |
| `{"type":"error",...}` without `id`            | whole connection failed, all streams retried |

The uploader retries connection errors, dropped connections and retryable
errors up to 5 times with exponential backoff (1s, 2s, 4s, ...). A non-retryable
error, or exceeding the attempts, leaves the file as `.done` so a later run can
try again; nothing is deleted. A retried upload is sent again from the start on
a fresh stream. The connection handshake times out after 30 seconds.

Rejections that must not be retried include malformed metadata, an
unsupported `kind`, a bad or missing hostkey and an oversized `size`. Use
`retryable:false` for those. A connection-level error without an `id` applies to
every stream on that connection.

## Suggested server layout

With the example templates:

```text
data/
  <hostname>/
    hostkey.hash            # hash of the accepted hostkey, optional
  active/                   # sessions that are still running
    <hostname>/
      <username>/
        <sessioncookie>.json
        <sessioncookie>.json.meta.json
  archive/
    <YYYY-mm-dd>/           # session start date
      <hostname>/
        <username>/
          <sessioncookie>.json
          <sessioncookie>.json.corrupt   # kept when a corrupt copy is replaced
          <sessioncookie>.json.meta.json
```

The metadata file records `hostname`, `username`, `session`, `kind`, `size`,
`sha256`, `startdate`, `finished` and the receive time. The stored `sha256` lets
the server answer the state message without re-reading the file. A finished
upload is written to the archive layout and removes any active copy. Snapshots
written to the archive by older receivers (metadata `finished:false`) are moved
back to the active layout when they are next seen. When a `corrupt` message is
received, rename the existing file to `<sessioncookie>.json.corrupt` (add a
timestamp suffix if one already exists) and clear the metadata before accepting
the new copy.

## Security requirements

- Serve uploads over `wss` (TLS). The uploader validates the server certificate
  against the system store plus optional `upload_ca`.
- If `hostkey` is used, compare it in constant time against a stored hash
  (e.g. SHA-256), never store or log it in plaintext.
- Sessions contain terminal output and typed input, including secrets. Restrict
  access to the receiver and its storage, and apply a retention policy.
- Enforce a maximum message and total upload size (configurable, e.g. 64 MiB)
  and reject uploads whose size or `sha256` does not match the metadata. Set a
  low `maxPayload` while waiting for the announce message.
- Do not trust `hostname`, `username` or `session` for filesystem paths without
  validating them (`hostname` as DNS name, username against a safe pattern,
  session as UUID). Use the values to build paths only after validation.
- The uploader sends the hostkey on every connection; rate limit and monitor
  authentication failures.
- Only accept binary frames for streams that had a valid announce message on
  that connection, and stop that stream once its announced `size` is exceeded.
- Bound the number of concurrent streams and connections per host.

## Example

A minimal server using the `ws` package. It multiplexes streams per connection
by reading the 4 byte stream id prefix:

```js
const { WebSocketServer } = require('ws');
const wss = new WebSocketServer({ port: 9023, maxPayload: 256 * 1024 });
const verbose = false; // upload_append_verbose: verbose answers, append is always on

wss.on('connection', (ws) => {
  const streams = new Map(); // id -> { meta, received }
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const id = data.readUInt32BE(0);
      const stream = streams.get(id);
      if (!stream) return; // no announce for this stream
      stream.received += data.length - 4;
      // append data.subarray(4) to the temp file, enforce stream.meta.size
      return;
    }
    const message = JSON.parse(data.toString());
    if (message.type === 'upload') {
      const offset = Number.isInteger(message.offset) ? message.offset : 0;
      streams.set(message.id, { meta: message, offset, received: 0,
        append: false, storedSize: 0 });
      const current = lookup(message); // stored size/sha256/finished or null
      const same = current
        && current.size === message.size
        && current.sha256 === message.sha256
        && !(message.finished === true && current.finished !== true);
      const append = current && !same && current.size === offset && offset > 0
        && message.finished === false && current.finished === false;
      if (same) {
        streams.delete(message.id); // in sync: no data, no second roundtrip
        ws.send(JSON.stringify({ type: 'state', id: message.id, exists: true,
          size: current.size, sha256: current.sha256,
          finished: current.finished, synced: true }));
      } else if (append) {
        streams.get(message.id).append = true;
        streams.get(message.id).storedSize = current.size;
        if (verbose) { // confirm; the default stays silent and appends on end
          ws.send(JSON.stringify({ type: 'state', id: message.id, exists: true,
            size: current.size, sha256: current.sha256,
            finished: current.finished }));
        }
      } else if (current) {
        ws.send(JSON.stringify({ type: 'state', id: message.id, exists: true,
          size: current.size, sha256: current.sha256,
          finished: current.finished }));
      } else {
        ws.send(JSON.stringify({ type: 'state', id: message.id,
          exists: false }));
      }
    } else if (message.type === 'synced') {
      ws.send(JSON.stringify({ type: 'ok', id: message.id })); // legacy
    } else if (message.type === 'corrupt') {
      markCorrupt(message); // rename stored file to .corrupt, clear metadata
      resetTemp(message.id); // discard any go-wrong tail, restart full
    } else if (message.type === 'replace') {
      resetTemp(message.id); // discard any go-wrong tail, restart full
    } else if (message.type === 'end') {
      // append: seed the stored prefix, append the tail, verify the full
      // sha256. A short full-mode tail or a stale append is reported as a
      // go-wrong size and the stream is kept for the following replace.
      ws.send(JSON.stringify({ type: 'ok', id: message.id }));
    }
  });
});
```

## Implementation checklist

- [ ] Accept WebSocket connections on the configured endpoint over `wss`.
- [ ] Keep per-connection stream state and read the stream id prefix.
- [ ] Reply to `upload` with a `state` message (stored size and SHA-256).
- [ ] Validate metadata, received size and SHA-256.
- [ ] Validate `hostname` and optional `hostkey`; reply `retryable:false` on mismatch.
- [ ] Validate `username` and `session` before using them in paths.
- [ ] Handle `synced` (reply `ok`), `replace` (overwrite) and `corrupt`
      (move stored file to `.corrupt`).
- [ ] Append by default when the announced `offset` equals the stored size (seed
      the prefix, append the tail); report a go-wrong size when it differs, when
      nothing is stored, and when an append prefix is stale, so the uploader
      re-sends in full. Stay silent for a normal append unless
      `upload_append_verbose`. Verify the full SHA-256 on `end`.
- [ ] Atomically replace the stored log (temp file + rename).
- [ ] Store metadata (including SHA-256) and expose it for inspection.
- [ ] Configure retention and maximum body size.
- [ ] Log uploads without leaking hostkeys or session content.
- [ ] Optional: endpoint to list and download sessions for restore.

## Future work

- Compression (per-message deflate) for large logs.
- Signed uploads (HMAC of the announce message and file with `hostkey`) instead
  of sending the hostkey on every connection.
- Server-side restore: feed the log back into wslogin.
- Deletion and retention APIs.
