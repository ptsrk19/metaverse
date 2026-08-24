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

function gitPushInternal(htmlContent, cb) {
  const run = (cmd, args) => new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd: ROOT }, (err, stdout, stderr) => {
      if (err) return reject(new Error([stderr, stdout, err.message].filter(Boolean).join('\n')));
      resolve(stdout);
    });
  });

  const targetBranch = process.env.GIT_BRANCH || 'main';

  const steps = [];
  steps.push(() => {
    ['config.lock', 'index.lock'].forEach(f => {
      const p = path.join(ROOT, '.git', f);
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        console.warn('[save] removed stale git lock file:', f);
      }
    });
    return 'lock check done';
  });
  steps.push(() => run('git', ['config', 'user.email', process.env.GIT_USER_EMAIL || 'gep-world-bot@example.com']));
  steps.push(() => run('git', ['config', 'user.name', process.env.GIT_USER_NAME || 'GEP World Admin']));
  if (process.env.GIT_REMOTE_URL) {
    steps.push(() => run('git', ['remote', 'add', 'origin', process.env.GIT_REMOTE_URL])
      .catch(() => run('git', ['remote', 'set-url', 'origin', process.env.GIT_REMOTE_URL])));
  }

  steps.push(() => run('git', ['fetch', 'origin', targetBranch]).catch(() => null));
  steps.push(() => run('git', ['reset', '--hard', 'origin/' + targetBranch]).catch(() => null));
  steps.push(() => { fs.writeFileSync(TARGET_FILE, htmlContent, 'utf8'); return 'reapplied'; });

  steps.push(() => run('git', ['add', 'index.html']));
  steps.push(() => run('git', ['commit', '-m', 'Admin save: ' + new Date().toISOString()])
    .catch(err => {
      if (/nothing (added )?to commit/i.test(err.message)) return 'nothing to commit — skipping';
      throw err;
    }));
  steps.push(() => run('git', ['push', 'origin', 'HEAD:' + targetBranch]));

  steps.reduce((p, step) => p.then(step), Promise.resolve())
    .then(() => cb(null))
    .catch(err => cb(err));
}

let gitQueue = Promise.resolve();
function gitPush(htmlContent, cb) {
  gitQueue = gitQueue
    .then(() => new Promise(resolve => gitPushInternal(htmlContent, err => { cb(err); resolve(); })))
    .catch(() => {});
}

function spliceState(html, state) {
  const safe = JSON.stringify(state)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
  const closeTag = '<' + '/script>';
  const openTag = '<script id="gep-saved-state">';
  const block = openTag + 'window.__GEP_SAVED_STATE__=' + safe + ';' + closeTag;

  const populatedMarker = openTag + 'window.__GEP_SAVED_STATE__=';
  const start = html.indexOf(populatedMarker);
  if (start >= 0) {
    const end = html.indexOf(closeTag, start);
    if (end >= 0) {
      return html.slice(0, start) + block + html.slice(end + closeTag.length);
    }
  }
  const anchor = '<script id="metaverse-glb-data"';
  const pos = html.indexOf(anchor);
  if (pos >= 0) {
    return html.slice(0, pos) + block + '\n' + html.slice(pos);
  }
  throw new Error('Could not find an insertion point in index.html (unexpected file structure)');
}

app.post('/__save', (req, res) => {
  const state = req.body && req.body.state;
  console.log(`[save] request received — ${JSON.stringify(state && state.editables ? state.editables.length : 0)} editable(s), body ~${JSON.stringify(req.body || {}).length} bytes`);
  if (!state || typeof state !== 'object') {
    console.error('[save] rejected: missing or invalid state in body');
    return res.status(400).json({ ok: false, error: 'Missing or invalid state in request body' });
  }
  let updatedHTML;
  try {
    if (!fs.existsSync(TARGET_FILE)) {
      console.error('[save] rejected: index.html not found on server at', TARGET_FILE);
      return res.status(500).json({ ok: false, error: 'index.html not found on server' });
    }
    ensureBackupDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(TARGET_FILE, path.join(BACKUP_DIR, `index-${ts}.html`));
    pruneBackups();

    const currentHTML = fs.readFileSync(TARGET_FILE, 'utf8');
    updatedHTML = spliceState(currentHTML, state);
    fs.writeFileSync(TARGET_FILE, updatedHTML, 'utf8');
    console.log(`[save] wrote ${updatedHTML.length} bytes to ${TARGET_FILE} (backup: index-${ts}.html)`);
  } catch (err) {
    console.error('[save] write failed:', err);
    return res.status(500).json({ ok: false, error: 'Write failed: ' + err.message });
  }

  if (!AUTO_GIT_PUSH) {
    console.log('[save] AUTO_GIT_PUSH is off — local write only, done.');
    return res.json({ ok: true, pushed: false });
  }

  console.log('[save] AUTO_GIT_PUSH is on — attempting git commit + push...');
  gitPush(updatedHTML, (err) => {
    if (err) {
      console.error('[save] git push failed:', err.message);
      return res.json({ ok: true, pushed: false, gitError: err.message });
    }
    console.log('[save] git push succeeded.');
    res.json({ ok: true, pushed: true });
  });
});

app.listen(PORT, () => {
  console.log(`GEP Virtual World running at http://localhost:${PORT}`);
  console.log(`Admin "Save Changes" will overwrite ${TARGET_FILE} in place.`);
  console.log(`Auto git push: ${AUTO_GIT_PUSH ? 'ON' : 'OFF (set AUTO_GIT_PUSH=true to enable)'}`);
});
