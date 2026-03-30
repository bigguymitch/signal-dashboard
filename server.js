const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.use(cors());

// ── BASIC AUTH ───────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.method === 'POST' && req.path === '/api/report') return next();
  if (req.path.startsWith('/api/memory/')) return next();
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Signal Dashboard"');
    return res.status(401).send('Authentication required');
  }
  const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString();
  const [user, pass] = credentials.split(':');
  if (user === process.env.DASH_USER && pass === process.env.DASH_PASS) return next();
  res.set('WWW-Authenticate', 'Basic realm="Signal Dashboard"');
  return res.status(401).send('Invalid credentials');
});

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ limit: '10mb', type: '*/*' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── POSTGRES ─────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false
});

// ── MIGRATIONS ───────────────────────────────────────────────
async function migrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        client TEXT NOT NULL,
        report_text TEXT NOT NULL,
        status TEXT DEFAULT 'auto',
        score TEXT DEFAULT 'AMBER',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS context_messages (
        id SERIAL PRIMARY KEY,
        report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        is_action INTEGER DEFAULT 0,
        done INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS status_history (
        id SERIAL PRIMARY KEY,
        report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
        from_status TEXT,
        to_status TEXT,
        reason TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('Database migrations complete');
  } catch(e) {
    console.error('Migration error:', e.message);
  } finally {
    client.release();
  }
}

// ── ROUTES ───────────────────────────────────────────────────

// POST /api/report
app.post('/api/report', async (req, res) => {
  try {
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

    let score = 'AMBER';
    const scoreMatch = report_text.match(/^SIGNAL_SCORE:\s*(RED|AMBER|GREEN)\s*\n?/m);
    if (scoreMatch) {
      score = scoreMatch[1];
      report_text = report_text.replace(/^SIGNAL_SCORE:\s*(RED|AMBER|GREEN)\s*\n?/m, '').trim();
    }

    const result = await pool.query(
      'INSERT INTO reports (client, report_text, status, score) VALUES ($1, $2, $3, $4) RETURNING id',
      [client, report_text, 'auto', score]
    );
    res.json({ id: result.rows[0].id });
  } catch(e) {
    console.error('POST /api/report error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/reports — latest per client, sorted RED > AMBER > GREEN > actioned
app.get('/api/reports', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (client) *
      FROM reports
      ORDER BY client, created_at DESC
    `);

    // Sort: actioned last, then by score
    const scoreOrder = { RED: 0, AMBER: 1, GREEN: 2 };
    const sorted = result.rows.sort((a, b) => {
      if (a.status === 'actioned' && b.status !== 'actioned') return 1;
      if (b.status === 'actioned' && a.status !== 'actioned') return -1;
      return (scoreOrder[a.score] ?? 1) - (scoreOrder[b.score] ?? 1);
    });

    res.json(sorted);
  } catch(e) {
    console.error('GET /api/reports error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/reports/:client — all reports for a client
app.get('/api/reports/:client', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT r.*, 
        (SELECT COUNT(*) FROM context_messages WHERE report_id = r.id) as reply_count
      FROM reports r
      WHERE client = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [req.params.client]);
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/report/:id
app.get('/api/report/:id', async (req, res) => {
  try {
    const report = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!report.rows.length) return res.status(404).json({ error: 'Not found' });
    const messages = await pool.query('SELECT * FROM context_messages WHERE report_id = $1 ORDER BY created_at ASC', [req.params.id]);
    const history = await pool.query('SELECT * FROM status_history WHERE report_id = $1 ORDER BY created_at ASC', [req.params.id]);
    res.json({ ...report.rows[0], messages: messages.rows, history: history.rows });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/report/:id
app.delete('/api/report/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/context
app.post('/api/context', async (req, res) => {
  try {
    const { report_id, message, is_action } = req.body;
    if (!report_id || !message) return res.status(400).json({ error: 'Missing fields' });

    const result = await pool.query(
      'INSERT INTO context_messages (report_id, message, is_action) VALUES ($1, $2, $3) RETURNING id',
      [report_id, message, is_action ? 1 : 0]
    );

    const report = await pool.query('SELECT * FROM reports WHERE id = $1', [report_id]);
    if (report.rows.length && report.rows[0].status === 'auto') {
      await pool.query('UPDATE reports SET status = $1 WHERE id = $2', ['actioned', report_id]);
      await pool.query(
        'INSERT INTO status_history (report_id, from_status, to_status, reason) VALUES ($1, $2, $3, $4)',
        [report_id, 'auto', 'actioned', message]
      );
    }

    res.json({ id: result.rows[0].id });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/context/:id
app.delete('/api/context/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM context_messages WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/context/:id/done
app.patch('/api/context/:id/done', async (req, res) => {
  try {
    const msg = await pool.query('SELECT * FROM context_messages WHERE id = $1', [req.params.id]);
    if (!msg.rows.length) return res.status(404).json({ error: 'Not found' });
    const newDone = msg.rows[0].done ? 0 : 1;
    await pool.query('UPDATE context_messages SET done = $1 WHERE id = $2', [newDone, req.params.id]);
    res.json({ done: newDone });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/report/:id/status
app.patch('/api/report/:id/status', async (req, res) => {
  try {
    const { status, reason } = req.body;
    const report = await pool.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    if (!report.rows.length) return res.status(404).json({ error: 'Not found' });
    await pool.query('UPDATE reports SET status = $1 WHERE id = $2', [status, req.params.id]);
    await pool.query(
      'INSERT INTO status_history (report_id, from_status, to_status, reason) VALUES ($1, $2, $3, $4)',
      [req.params.id, report.rows[0].status, status, reason || '']
    );
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/clients
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT client FROM reports ORDER BY client');
    res.json(result.rows.map(r => r.client));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/memory/:client
app.get('/api/memory/:client', async (req, res) => {
  try {
    const client = decodeURIComponent(req.params.client);
    const reports = await pool.query(`
      SELECT id, report_text, created_at, status, score
      FROM reports WHERE client = $1
      ORDER BY created_at DESC LIMIT 4
    `, [client]);

    let text = '';
    for (const r of reports.rows) {
      const d = new Date(r.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' });
      const notes = await pool.query(
        'SELECT message, done FROM context_messages WHERE report_id = $1 ORDER BY created_at ASC',
        [r.id]
      );
      text += `--- Previous Report: ${d} (Score: ${r.score || 'AMBER'}) ---\n`;
      text += r.report_text.substring(0, 600) + '...\n';
      if (notes.rows.length) {
        text += `Account manager notes:\n`;
        notes.rows.forEach(n => { text += `- ${n.done ? '[RESOLVED] ' : ''}${n.message}\n`; });
      }
      text += '\n';
    }

    res.json({ text: text || 'No previous reports available.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
migrate().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
