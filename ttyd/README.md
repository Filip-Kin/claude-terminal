# ttyd/

Source of truth for ttyd's native `-I`/`--index` overlay injection (Zoraxy migration —
retires the old nginx `sub_filter` hack, which has no Zoraxy equivalent). See the main
README's "ttyd overlay injection" section for the mechanism.

- `index.html` — ttyd's pristine page (captured via loopback `curl` against a real ttyd
  instance) with `<script src="/_ct/overlay.js?v=NN"></script>` inserted before `</head>`.
  Bump `?v=` here whenever `overlay.js` changes.
- `ttyd.service` — filip's host systemd unit, updated to add `-I` pointing at this
  directory's `index.html` (this NAS path, so it picks up edits without a rebuild) plus
  the `media-nas.mount` dependency that requires, matching `claude-terminal.service`'s
  own convention. This is the file to diff/apply against the live
  `/etc/systemd/system/ttyd.service` — it is **not** copied there automatically.

The guest-claude image gets its own baked-in copy (`guest-claude/ttyd/index.html`,
`COPY`'d to `/usr/local/share/ttyd/index.html` in the Dockerfile) rather than mounting
this path directly, since guest containers can't see the host NAS mount.
`guest-claude/update-guests.sh` syncs the current copy from here into
`guest-claude/ttyd/index.html` before every rebuild, same pattern already used for the
claude-terminal sidecar itself.

## Rollout

**Host (filip):**
```
sudo cp ttyd.service /etc/systemd/system/ttyd.service
sudo systemctl daemon-reload
sudo systemctl restart ttyd.service
curl -s http://127.0.0.1:7681/ | grep -o '<script src="/_ct/overlay.js[^>]*></script>'
```
One restart to pick up the `-I` flag; after that, editing `index.html` in place (e.g. a
version bump) needs no further restart — verified ttyd re-reads `-I` per request.

**Guests:** already wired into `guest-claude/Dockerfile` + `entrypoint.sh` (see that
repo). Takes effect on the next `update-guests.sh` / `recreate-all.sh` rebuild — no
separate step needed here.

**Rollback:** restore the previous `/etc/systemd/system/ttyd.service` (drop the `-I`
flag and the `media-nas.mount` dependency), `daemon-reload`, `restart ttyd.service`.
ttyd falls back to serving its own built-in page; the `/_ct/*` proxy routes and the
overlay script itself are unaffected either way.
