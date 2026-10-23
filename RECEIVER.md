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
upload_active_interval_seconds=1
upload_watch_debounce_ms=500
upload_remove_uploaded=false
upload_connections=4
upload_high_water_bytes=1048576
upload_ca=/etc/wslogin/upload-ca.pem
```

- `upload_enabled` defaults to `false`.
- `upload_url` is required when uploads are enabled; `ws` and `wss` are
  supported. `http`/`https` are accepted as aliases and mapped to `ws`/`wss`.
- `upload_interval_seconds` is the fallback rescan interval. Changes are
  normally detected by a recursive file monitor, so this only recovers from
  missed filesystem events. Defaults to `60`.
- `upload_active_enabled` uploads snapshots of sessions that are still running.
  Defaults to `true`; finished logs are always uploaded.
- `upload_active_interval_seconds` is the minimum time between snapshots of the
  same active session. Defaults to `1`, so writes are uploaded almost
  immediately. Uploads of one session are serialized, and changes that arrive
  during an upload are coalesced into the next snapshot so an older snapshot
  can never overwrite a newer one on the receiver.
- `upload_watch_debounce_ms` is how long the uploader waits after a filesystem
  event before taking a snapshot, coalescing a burst of writes. Defaults to
  `500`. Setting it too low uploads many tiny snapshots; raising
  `upload_active_interval_seconds` bounds the rate further.
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

## Receiver configuration

```ini
receiver_port=9023
receiver_data_dir=uploads
receiver_max_size=67108864
receiver_require_hostkey=false
receiver_active_template=active/<hostname>/<username>/<session>.json
receiver_store_template=archive/<%date YYYY-mm-dd>/<hostname>/<username>/<session>.json
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
new snapshot shortly after it changes (at most once per
`upload_active_interval_seconds`). The receiver stores these snapshots in the
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
already uploaded for the same session is not sent again.

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
| `startdate`| no       | session start, seconds since the epoch          |
| `finished` | no       | `false` for an active snapshot, default `true`  |

### 2. State and integrity check

In response to the announce the server replies with the state of the file it
currently stores for `hostname/username/session`:

```json
{"type": "state", "id": 7, "exists": true, "size": 123456, "sha256": "9f86d0818..."}
```

`exists` is `false` when nothing is stored yet, in which case `size` and
`sha256` may be omitted. The uploader compares the reported state with its own
`size` and `sha256` and then:

- **remote matches** the local file: sends `{"type":"synced","id":7}` with no
  file data. The server replies `ok`; nothing is transferred.
- **remote differs and the log is finished**: sends
  `{"type":"corrupt","id":7}`. The server must move its existing file for that
  session aside to `.corrupt` and forget the stored hash. The uploader then
  streams the file as described below and the server stores the fresh copy.
- **remote differs and the log is active** (`finished:false`): sends
  `{"type":"replace","id":7}`. The uploader streams the new snapshot and the
  server replaces the stored file in place; no `.corrupt` copy is kept.
- **nothing stored**: streams the file directly.

This lets the uploader verify the receiver before sending and lets a receiver
whose copy is damaged ask for a fresh copy. A damaged finished log is kept as
`<sessioncookie>.corrupt` rather than being overwritten; active snapshots
simply replace each other.

### 3. Data

The complete session log (`<sessioncookie>.json`) is sent as binary frames. Each
binary frame is prefixed with the 4 byte big endian stream id:

```text
+----------------+-----------------------------+
| id (4 bytes BE)| file data (128 KiB max)     |
+----------------+-----------------------------+
```

The server strips the 4 byte prefix, looks up the stream and writes the data to
that stream's temporary file. Frames of different streams may be interleaved in
any order; per stream the order is preserved. The uploader sends 128 KiB per
frame, so a frame boundary has no meaning.

The log is a sequence of JSON objects, one per line. Line format (internal, may
evolve):

```json
{"t":1698000000.0,"d":"...","c":0}
```

`c` is the record type: `0` command, `1` terminal output, `2` user input,
`3` exit status. `t` is a Unix timestamp and `d` the payload.

The uploader sends the **whole file** for every snapshot, including active
sessions. The receiver should treat the upload as a snapshot and replace the
stored log for `hostname/username/session` atomically.

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

## Responses

| Reply                                          | Meaning                                 |
|------------------------------------------------|-----------------------------------------|
| `{"type":"state","id":N,...}`                  | reply to an announce, see above         |
| `{"type":"ok","id":N}`                         | stored / in sync; uploader marks uploaded|
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
      streams.set(message.id, { meta: message, received: 0 });
      const current = lookup(message); // stored size/sha256 or null
      ws.send(JSON.stringify(current
        ? { type: 'state', id: message.id, exists: true,
            size: current.size, sha256: current.sha256 }
        : { type: 'state', id: message.id, exists: false }));
    } else if (message.type === 'synced') {
      ws.send(JSON.stringify({ type: 'ok', id: message.id }));
    } else if (message.type === 'corrupt') {
      markCorrupt(message); // rename stored file to .corrupt, clear metadata
    } else if (message.type === 'replace') {
      // next data/end replaces the stored snapshot in place
    } else if (message.type === 'end') {
      // verify size/sha256, move the temp file in place, store size/sha256
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
- [ ] Atomically replace the stored log (temp file + rename).
- [ ] Store metadata (including SHA-256) and expose it for inspection.
- [ ] Configure retention and maximum body size.
- [ ] Log uploads without leaking hostkeys or session content.
- [ ] Optional: incremental log upload using `offset` to save bandwidth.
- [ ] Optional: endpoint to list and download sessions for restore.

## Future work

- Incremental log uploads: send only bytes after the last acknowledged offset,
  with `offset` in the request and append semantics on the server.
- Compression (per-message deflate) for large logs.
- Signed uploads (HMAC of the announce message and file with `hostkey`) instead
  of sending the hostkey on every connection.
- Server-side restore: feed the log back into wslogin.
- Deletion and retention APIs.
