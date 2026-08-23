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
// by this repo updates automatically too). Set these before `npm start`:
//   AUTO_GIT_PUSH=true
//   (the folder must already be a git repo with a remote configured and
//    credentials that can push non-interactively, e.g. a PAT in the
//    remote URL or an SSH key loaded in the agent)
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
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
  run('git', ['add', 'index.html'])
    .then(() => run('git', ['commit', '-m', 'Admin save: ' + new Date().toISOString()]))
    .then(() => run('git', ['push']))
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

  const start = html.indexOf(openTag);
  if (start >= 0) {
    const end = html.indexOf(closeTag, start);
    if (end >= 0) {
      return html.slice(0, start) + block + html.slice(end + closeTag.length);
    }
  }
  const threeClose = '<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js">' + closeTag;
  const pos = html.indexOf(threeClose);
  if (pos >= 0) {
    return html.slice(0, pos + threeClose.length) + block + html.slice(pos + threeClose.length);
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
