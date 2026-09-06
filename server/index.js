require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pool = require('./db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_lifting_key';

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token.' });
    req.user = user;
    next();
  });
}

// ---- AUTH ROUTES ----

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, hashedPassword]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'User registration failed (email might already exist)' });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userResult.rows.length === 0) return res.status(400).json({ error: 'User not found' });
    const user = userResult.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) return res.status(400).json({ error: 'Invalid password' });
    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, userId: user.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ---- SESSIONS ----

app.get('/api/sessions', authenticateToken, async (req, res) => {
  try {
    const sessions = await pool.query(
      'SELECT * FROM sessions WHERE user_id = $1 ORDER BY session_date DESC',
      [req.user.id]
    );
    const sessionsWithSets = await Promise.all(
      sessions.rows.map(async (session) => {
        const sets = await pool.query(
          'SELECT * FROM sets WHERE session_id = $1 ORDER BY set_number',
          [session.id]
        );
        return { ...session, sets: sets.rows };
      })
    );
    res.json(sessionsWithSets);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

app.post('/api/sessions', authenticateToken, async (req, res) => {
  const { session_date, lift_type, notes, sets } = req.body;
  if (!session_date || !lift_type) return res.status(400).json({ error: 'session_date and lift_type are required' });
  try {
    const sessionResult = await pool.query(
      'INSERT INTO sessions (user_id, session_date, lift_type, notes) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, session_date, lift_type, notes || null]
    );
    const session = sessionResult.rows[0];
    const insertedSets = [];
    if (Array.isArray(sets)) {
      for (const set of sets) {
        const setResult = await pool.query(
          'INSERT INTO sets (session_id, set_number, weight_lb, reps, rpe) VALUES ($1, $2, $3, $4, $5) RETURNING *',
          [session.id, set.set_number, set.weight_lb, set.reps, set.rpe || null]
        );
        insertedSets.push(setResult.rows[0]);
      }
    }
    res.status(201).json({ ...session, sets: insertedSets });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ---- WEIGH-INS ----

app.get('/api/weigh-ins', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM weigh_ins WHERE user_id = $1 ORDER BY weigh_date ASC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch weigh-ins' });
  }
});

app.post('/api/weigh-ins', authenticateToken, async (req, res) => {
  const { weigh_date, weight_kg } = req.body;
  if (!weigh_date || !weight_kg) return res.status(400).json({ error: 'weigh_date and weight_kg are required' });
  try {
    const result = await pool.query(
      'INSERT INTO weigh_ins (user_id, weigh_date, weight_kg) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, weigh_date, weight_kg]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create weigh-in' });
  }
});

// ---- BLOCKS ----
// "current" block is computed by the caller (frontend) from start/end dates —
// this just returns every block the user has created.

app.get('/api/blocks', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM blocks WHERE user_id = $1 ORDER BY start_date DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch blocks' });
  }
});

app.post('/api/blocks', authenticateToken, async (req, res) => {
  const { name, start_date, end_date } = req.body;
  if (!name || !start_date) return res.status(400).json({ error: 'name and start_date are required' });
  try {
    const result = await pool.query(
      'INSERT INTO blocks (user_id, name, start_date, end_date) VALUES ($1, $2, $3, $4) RETURNING *',
      [req.user.id, name, start_date, end_date || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create block' });
  }
});

// ---- ALL-TIME PRs ----
// best (max weight) set ever logged, per lift, regardless of which block it fell in.

app.get('/api/prs', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT DISTINCT ON (s.lift_type)
         s.lift_type, st.weight_lb, st.reps, s.session_date
       FROM sessions s
       JOIN sets st ON st.session_id = s.id
       WHERE s.user_id = $1
       ORDER BY s.lift_type, st.weight_lb DESC, s.session_date ASC`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch PRs' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});