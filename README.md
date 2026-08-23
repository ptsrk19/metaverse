# GEP Virtual World — persistent admin saves

## Why saves were "getting corrupted"

The original file is 100% client-side (Three.js in a single HTML file). A
browser tab has no permission to overwrite a file on your disk for security
reasons, so the old "Save Changes" button could only do a **download of a
brand-new file** with the edits baked in. You then had to manually find that
download and swap it in for the old one — easy to mix up versions, and once
images/videos push the file into the tens-of-megabytes range, that manual
shuffle is where things broke.

This package adds a tiny local server. The admin panel now saves **to that
server**, which overwrites `index.html` on disk directly. No download, no
manual swap — the file you're serving *is* the file that just got saved.

## Run it locally

```bash
cd gep-world
npm install
npm start
```

Open **http://localhost:3000**. Go into Admin, add/move images or videos,
click **Save Changes**. It now shows "Saved — this is now the live file on
this server." Refresh the page (or have anyone else on your network hit
`http://<your-ip>:3000`) and the edit is there — `index.html` itself was
rewritten.

Every save also drops a timestamped backup copy in `backups/` first, so
nothing is ever lost even if a save goes wrong.

If you open `index.html` directly from disk (double-click, `file://`) or
host it on plain static hosting with no server behind it, the Save button
automatically falls back to the old "download a new file" behaviour — it
detects the server isn't there and won't just fail silently.

## Getting this onto GitHub / GitHub Pages

GitHub Pages only serves static files — it can't run `server.js` or accept
the save request. There are two ways to combine "edit live" with "hosted on
GitHub":

**Option A — edit locally, publish to GitHub Pages when ready (simplest)**
1. Put this folder in a git repo, push it, enable GitHub Pages for it.
2. Do your admin editing against `npm start` on your own machine (or a
   colleague's), where saves are instant and in-place.
3. When you're happy with the state, `git add index.html && git commit -m "update" && git push` — GitHub Pages picks up the new `index.html` automatically.

**Option B — auto-push every save to GitHub**
Run the server on a machine that has push access to the repo (a PAT in the
remote URL, or an SSH key already loaded), then:

```bash
AUTO_GIT_PUSH=true npm start
```

Now every click of "Save Changes" also runs `git add / commit / push` for
you, so GitHub (and GitHub Pages, if enabled) stays in sync with the live
edits automatically. This only makes sense if one person/machine is doing
the editing at a time — it's a simple commit-and-push, not multi-user
conflict resolution.

**Option C — keep it running as a real backend (not just local)**
Deploy `server.js` itself (it's a plain Express app) to something that can
run a Node process and has a persistent/writable disk — a small VPS,
Render, Railway, Fly.io, etc. Then the admin panel is "live" for anyone
who hits that URL, the same way it is on localhost. GitHub Pages still
can't do this part; you need an actual server for a live write-back save,
GitHub Pages for a static publish of the result, or both together as in
Option B.

## Notes

- The world's base 3D model is already ~18MB embedded as base64 in
  `index.html` — that's normal for this file, not a symptom of corruption.
  Adding several images/videos will keep growing the file; if you're adding
  a lot of media, consider raising `limit` in `server.js`'s `/__save` route
  (currently 1024mb) if you ever hit it.
- `backups/` is created automatically on first save. Prune it manually
  whenever you like — it's just chronological safety copies.
