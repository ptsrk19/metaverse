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

// The saved world (base GLB + any images/videos admins add) can get large,
// so allow a generous body size on the save endpoint specifically.
app.use('/__save', express.text({ type: '*/*', limit: '1024mb' }));

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

app.post('/__save', (req, res) => {
  const html = req.body;
  if (!html || typeof html !== 'string' || html.length < 100) {
    return res.status(400).json({ ok: false, error: 'Empty or invalid HTML body' });
  }
  try {
    ensureBackupDir();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    // Snapshot the current live file before overwriting it, so a bad save
    // (or a browser glitch) never loses the previous good version.
    if (fs.existsSync(TARGET_FILE)) {
      fs.copyFileSync(TARGET_FILE, path.join(BACKUP_DIR, `index-${ts}.html`));
      pruneBackups();
    }
    fs.writeFileSync(TARGET_FILE, html, 'utf8');
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
