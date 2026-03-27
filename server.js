const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: '*/*' }));
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database('./reports.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    report_text TEXT NOT NULL,
    status TEXT DEFAULT 'auto',
    score TEXT DEFAULT 'GREEN',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS context_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    is_action INTEGER DEFAULT 0,
    done INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (report_id) REFERENCES reports(id)
  );
  CREATE TABLE IF NOT EXISTS status_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (report_id) REFERENCES reports(id)
  );
`);

// Migrations — safe to run every time
try { db.exec(`ALTER TABLE reports ADD COLUMN status TEXT DEFAULT 'auto'`); } catch(e) {}
try { db.exec(`ALTER TABLE reports ADD COLUMN score TEXT DEFAULT 'GREEN'`); } catch(e) {}
try { db.exec(`ALTER TABLE context_messages ADD COLUMN is_action INTEGER DEFAULT 0`); } catch(e) {}
try { db.exec(`ALTER TABLE context_messages ADD COLUMN done INTEGER DEFAULT 0`); } catch(e) {}

// POST /api/report — receives report from Make, extracts score from text
app.post('/api/report', (req, res) => {
  let client, report_text;
  if (typeof req.body === 'string') {
    client = req.headers['x-client-name'] || 'Unknown';
    report_text = req.body;
  } else {
    client = req.body.client;
    report_text = req.body.report_text;
  }
  if (!client || !report_text) return res.status(400).json({ error: 'Missing fields' });
  try { report_text = decodeURIComponent(report_text); } catch(e) {}
  report_text = report_text.replace(/\\n/g, '\n');

  // Extract SIGNAL_SCORE from report text then strip it out
  let score = 'AMBER';
  const scoreMatch = report_text.match(/^SIGNAL_SCORE:\s*(RED|AMBER|GREEN)\s*\n?/m);
  if (scoreMatch) {
    score = scoreMatch[1];
    report_text = report_text.replace(/^SIGNAL_SCORE:\s*(RED|AMBER|GREEN)\s*\n?/m, '').trim();
  }

  const result = db.prepare(
    'INSERT INTO reports (client, report_text, status, score) VALUES (?, ?, ?, ?)'
  ).run(client, report_text, 'auto', score);

  res.json({ id: result.lastInsertRowid });
});

// GET /api/reports — latest report per client, sorted RED > AMBER > GREEN > actioned
app.get('/api/reports', (req, res) => {
  const reports = db.prepare(`
    SELECT r.*
    FROM reports r
    INNER JOIN (
      SELECT client, MAX(created_at) as max_created
      FROM reports
      GROUP BY client
    ) latest ON r.client = latest.client AND r.created_at = latest.max_created
    ORDER BY
      CASE r.status WHEN 'actioned' THEN 1 ELSE 0 END,
      CASE r.score WHEN 'RED' THEN 0 WHEN 'AMBER' THEN 1 WHEN 'GREEN' THEN 2 ELSE 3 END,
      r.created_at DESC
  `).all();
  res.json(reports);
});

// GET /api/reports/:client — all reports for a client
app.get('/api/reports/:client', (req, res) => {
  const reports = db.prepare(`
    SELECT r.*, (SELECT COUNT(*) FROM context_messages WHERE report_id = r.id) as reply_count
    FROM reports r WHERE client = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.params.client);
  res.json(reports);
});

// GET /api/report/:id — single report with messages and history
app.get('/api/report/:id', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  const messages = db.prepare('SELECT * FROM context_messages WHERE report_id = ? ORDER BY created_at ASC').all(req.params.id);
  const history = db.prepare('SELECT * FROM status_history WHERE report_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json({ ...report, messages, history });
});

// DELETE /api/report/:id
app.delete('/api/report/:id', (req, res) => {
  db.prepare('DELETE FROM context_messages WHERE report_id = ?').run(req.params.id);
  db.prepare('DELETE FROM status_history WHERE report_id = ?').run(req.params.id);
  db.prepare('DELETE FROM reports WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/context — add a note
app.post('/api/context', (req, res) => {
  const { report_id, message, is_action } = req.body;
  if (!report_id || !message) return res.status(400).json({ error: 'Missing fields' });
  const result = db.prepare(
    'INSERT INTO context_messages (report_id, message, is_action) VALUES (?, ?, ?)'
  ).run(report_id, message, is_action ? 1 : 0);
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(report_id);
  if (report && report.status === 'auto') {
    db.prepare('UPDATE reports SET status = ? WHERE id = ?').run('actioned', report_id);
    db.prepare('INSERT INTO status_history (report_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)').run(report_id, 'auto', 'actioned', message);
  }
  res.json({ id: result.lastInsertRowid });
});

// DELETE /api/context/:id
app.delete('/api/context/:id', (req, res) => {
  db.prepare('DELETE FROM context_messages WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// PATCH /api/context/:id/done — toggle note done
app.patch('/api/context/:id/done', (req, res) => {
  const msg = db.prepare('SELECT * FROM context_messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  const newDone = msg.done ? 0 : 1;
  db.prepare('UPDATE context_messages SET done = ? WHERE id = ?').run(newDone, msg.id);
  res.json({ done: newDone });
});

// PATCH /api/report/:id/status — update status
app.patch('/api/report/:id/status', (req, res) => {
  const { status, reason } = req.body;
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE reports SET status = ? WHERE id = ?').run(status, req.params.id);
  db.prepare('INSERT INTO status_history (report_id, from_status, to_status, reason) VALUES (?, ?, ?, ?)').run(req.params.id, report.status, status, reason || '');
  res.json({ ok: true });
});

// GET /api/clients — distinct client list
app.get('/api/clients', (req, res) => {
  const clients = db.prepare('SELECT DISTINCT client FROM reports ORDER BY client').all();
  res.json(clients.map(r => r.client));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// GET /api/memory/:client — last 4 reports + notes for Claude context
app.get('/api/memory/:client', (req, res) => {
  const client = decodeURIComponent(req.params.client);
  const reports = db.prepare(`
    SELECT r.id, r.report_text, r.created_at, r.status, r.score
    FROM reports r WHERE r.client = ?
    ORDER BY r.created_at DESC LIMIT 4
  `).all(client);

  let text = '';
  reports.forEach((r, i) => {
    const d = new Date(r.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
    const notes = db.prepare('SELECT message, done FROM context_messages WHERE report_id = ? ORDER BY created_at ASC').all(r.id);
    text += `--- Previous Report ${i + 1}: ${d} (Score: ${r.score || 'AMBER'}) ---\n`;
    text += r.report_text.substring(0, 600) + '...\n';
    if (notes.length) {
      text += `Account manager notes:\n`;
      notes.forEach(n => { text += `- ${n.done ? '[RESOLVED] ' : ''}${n.message}\n`; });
    }
    text += '\n';
  });

  res.json({ text: text || 'No previous reports available.' });
});
