const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const db = new Database('./reports.db');

// Init tables
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client TEXT NOT NULL,
    report_text TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS context_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id INTEGER NOT NULL,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (report_id) REFERENCES reports(id)
  );
`);

// POST /report — Make.com sends reports here
app.post('/api/report', (req, res) => {
  const { client, report_text } = req.body;
  if (!client || !report_text) return res.status(400).json({ error: 'Missing fields' });
  const stmt = db.prepare('INSERT INTO reports (client, report_text) VALUES (?, ?)');
  const result = stmt.run(client, report_text);
  res.json({ id: result.lastInsertRowid });
});

// GET /reports — list all reports for a client
app.get('/api/reports/:client', (req, res) => {
  const reports = db.prepare(`
    SELECT r.*, 
    (SELECT COUNT(*) FROM context_messages WHERE report_id = r.id) as reply_count
    FROM reports r 
    WHERE client = ? 
    ORDER BY created_at DESC 
    LIMIT 50
  `).all(req.params.client);
  res.json(reports);
});

// GET /report/:id — get single report with context
app.get('/api/report/:id', (req, res) => {
  const report = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!report) return res.status(404).json({ error: 'Not found' });
  const messages = db.prepare('SELECT * FROM context_messages WHERE report_id = ? ORDER BY created_at ASC').all(req.params.id);
  res.json({ ...report, messages });
});

// POST /context — add context reply to a report
app.post('/api/context', (req, res) => {
  const { report_id, message } = req.body;
  if (!report_id || !message) return res.status(400).json({ error: 'Missing fields' });
  const stmt = db.prepare('INSERT INTO context_messages (report_id, message) VALUES (?, ?)');
  const result = stmt.run(report_id, message);
  res.json({ id: result.lastInsertRowid });
});

// GET /clients — list all clients
app.get('/api/clients', (req, res) => {
  const clients = db.prepare('SELECT DISTINCT client FROM reports ORDER BY client').all();
  res.json(clients.map(r => r.client));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
