// GEP Virtual World — local save server
// -----------------------------------------------------------------------
// Serves index.html and gives the in-browser Admin "Save Changes" button
// somewhere real to save TO: a POST /__save endpoint that overwrites
// index.html on disk. That's what makes the save "final" — no more
// downloading a new file every time and manually swapping it in.
//
// Usage:
//   npm install
//   npm start
//   open http://localhost:3000
//
// Optional: auto-push every save to GitHub (so a GitHub Pages site backed
// by this repo updates automatically too, and saves survive a host's
// container restarting with an ephemeral disk, e.g. Render's free tier).
// Set these before `npm start`:
//   AUTO_GIT_PUSH=true
//   GIT_REMOTE_URL=https://<token>@github.com/you/your-repo.git   (optional)
//   GIT_USER_EMAIL=you@example.com                                (optional)
//   GIT_USER_NAME="Your Name"                                     (optional)
// A fresh container has no git identity or push credentials configured by
// default, so these are set explicitly on every push rather than assumed.
// -----------------------------------------------------------------------

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TARGET_FILE = path.join(ROOT, 'index.html');
const BACKUP_DIR = path.join(ROOT, 'backups');
const MAX_BACKUPS = 20;
const AUTO_GIT_PUSH = String(process.env.AUTO_GIT_PUSH || '').toLowerCase() === 'true';

const app = express();

// The client now sends only the small state JSON (added images/videos and
// their positions), not the whole page — but images/videos are embedded as
// base64 data URLs, so still allow a generous body size here.
app.use('/__save', express.json({ limit: '512mb' }));

app.use(express.static(ROOT, { index: 'index.html' }));

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function pruneBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter(f => f.startsWith('index-') && f.endsWith('.html'))
    .sort(); // ISO timestamp prefix sorts chronologically
  while (files.length > MAX_BACKUPS) {
    fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  }
}

function gitPush(cb) {
  const run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT }, (err, stdout, stderr) => {
      // git writes "nothing to commit" to STDOUT, not stderr — combine
      // both into the error so callers can pattern-match on either.
      if (err) return reject(new Error([stderr, stdout, err.message].filter(Boolean).join('\n')));
      resolve(stdout);
    });
  });

  // A fresh container (Render, etc.) has no git identity or push
  // credentials configured by default. Set them from env vars each time
  // rather than assuming they're already there.
  const steps = [];
  steps.push(() => run('git', ['config', 'user.email', process.env.GIT_USER_EMAIL || 'gep-world-bot@example.com']));
  steps.push(() => run('git', ['config', 'user.name', process.env.GIT_USER_NAME || 'GEP World Admin']));
  if (process.env.GIT_REMOTE_URL) {
    // GIT_REMOTE_URL should be the full authenticated remote, e.g.
    // https://<token>@github.com/username/repo.git
    // Render's checkout doesn't always configure an 'origin' remote at
    // all (its own log showed "No such remote 'origin'" here) — 'set-url'
    // only works on a remote that already exists, so add it first and
    // only fall back to set-url if it turns out one is already there.
    steps.push(() => run('git', ['remote', 'add', 'origin', process.env.GIT_REMOTE_URL])
      .catch(() => run('git', ['remote', 'set-url', 'origin', process.env.GIT_REMOTE_URL])));
  }
  steps.push(() => run('git', ['add', 'index.html']));
  // A commit fails (non-zero exit) with "nothing to commit" when the file
  // content is identical to what's already committed — e.g. saving twice
  // in a row with no real change, or a retried request. That's not a
  // failure, just a no-op; swallow specifically that case so it doesn't
  // get logged and reported as an error, and still proceed to push in
  // case an earlier commit is sitting locally but hasn't been pushed yet.
  steps.push(() => run('git', ['commit', '-m', 'Admin save: ' + new Date().toISOString()])
    .catch(err => {
      if (/nothing to commit/i.test(err.message)) return 'nothing to commit — skipping';
      throw err;
    }));
  // Push explicitly to HEAD:main rather than a bare 'git push': Render's
  // checkout puts the repo in a detached-HEAD state (it checks out a
  // specific commit, not a branch), where a plain push fails with "You
  // are not currently on a branch." Pushing HEAD:main works regardless of
  // whether we're on a branch or detached.
  const targetBranch = process.env.GIT_BRANCH || 'main';
  steps.push(() => run('git', ['push', 'origin', 'HEAD:' + targetBranch]));

  steps.reduce((p, step) => p.then(step), Promise.resolve())
    .then(() => cb(null))
    .catch(err => cb(err));
}

// Splice a new gep-saved-state script block into an existing HTML string,
// touching nothing else in the file. This is deliberately the ONLY thing
// that ever changes index.html on disk — so the file's markup (the enter
// screen, panel states, everything) stays exactly as originally authored,
// and only the embedded world state (your images/videos/text/layout)
// updates. This is what prevents "corrupted" saves: we never write back a
// snapshot of a live, mid-session browser DOM — only this one script tag.
function spliceState(html, state) {
  const safe = JSON.stringify(state)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const closeTag = '<' + '/script>';
  const openTag = '<script id="gep-saved-state">';
  const block = openTag + 'window.__GEP_SAVED_STATE__=' + safe + ';' + closeTag;

  // IMPORTANT: search for the FULL populated marker (openTag + the
  // window.__GEP_SAVED_STATE__= assignment), never the bare openTag alone.
  // The bare openTag string also appears verbatim as this very source
  // file's own constant definition a few lines below — searching for it
  // finds that constant's own text on every save (including the very
  // first one), splicing new data into the middle of this function's own
  // code instead of an actual data location. That was the real cause
  // behind every "stuck loading" episode: it silently corrupted the file
  // from the first save onward, well before any of the other fixes here.
  const populatedMarker = openTag + 'window.__GEP_SAVED_STATE__=';
  const start = html.indexOf(populatedMarker);
  if (start >= 0) {
    const end = html.indexOf(closeTag, start);
    if (end >= 0) {
      return html.slice(0, start) + block + html.slice(end + closeTag.length);
    }
  }
  // Anchor on the metaverse-glb-data tag's id rather than the CDN <script>
  // tag: the CDN tag's exact attributes (onerror=...) are brittle and were
  // never actually matched here, silently breaking the very first save.
  // The id anchor is load-bearing for the app itself (getElementById
  // elsewhere), so it can't drift out from under this.
  const anchor = '<script id="metaverse-glb-data"';
  const pos = html.indexOf(anchor);
  if (pos >= 0) {
    return html.slice(0, pos) + block + '\n' + html.slice(pos);
  }
  throw new Error('Could not find an insertion point in index.html (unexpected file structure)');
}

app.post('/__save', (req, res) => {
  const state = req.body && req.body.state;
  if (!state || typeof state !== 'object') {
    return res.status(400).json({ ok: false, error: 'Missing or invalid state in request body' });
  }
  try {
    if (!fs.existsSync(TARGET_FILE)) {
      return res.status(500).json({ ok: false, error: 'index.html not found on server' });
    }
    ensureBackupDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // Snapshot the current live file before overwriting it, so a bad save
    // (or a browser glitch) never loses the previous good version.
    fs.copyFileSync(TARGET_FILE, path.join(BACKUP_DIR, `index-${ts}.html`));
    pruneBackups();

    const currentHTML = fs.readFileSync(TARGET_FILE, 'utf8');
    const updatedHTML = spliceState(currentHTML, state);
    fs.writeFileSync(TARGET_FILE, updatedHTML, 'utf8');
  } catch (err) {
    console.error('Save failed:', err);
    return res.status(500).json({ ok: false, error: 'Write failed: ' + err.message });
  }

  if (!AUTO_GIT_PUSH) {
    return res.json({ ok: true, pushed: false });
  }

  gitPush((err) => {
    if (err) {
      console.error('Git push failed:', err.message);
      // The local save already succeeded — still report ok, just not pushed.
      return res.json({ ok: true, pushed: false, gitError: err.message });
    }
    res.json({ ok: true, pushed: true });
  });
});

app.listen(PORT, () => {
  console.log(`GEP Virtual World running at http://localhost:${PORT}`);
  console.log(`Admin "Save Changes" will overwrite ${TARGET_FILE} in place.`);
  console.log(`Auto git push: ${AUTO_GIT_PUSH ? 'ON' : 'OFF (set AUTO_GIT_PUSH=true to enable)'}`);
});
