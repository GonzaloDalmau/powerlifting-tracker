const express = require('express');
const pool = require('./db');
 
const app = express();
const PORT = 3000;
 
app.use(express.json()); // lets us read JSON bodies sent from the frontend
 
app.get('/', (req, res) => {
  res.send('Server is running!');
});
 
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ message: 'Database connected!', time: result.rows[0].now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database connection failed', details: err.message });
  }
});
 
// GET all sessions, each with its sets nested inside
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await pool.query('SELECT * FROM sessions ORDER BY session_date DESC');
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
    res.status(500).json({ error: 'Failed to fetch sessions', details: err.message });
  }
});
 
// POST a new session along with its sets, e.g.:
// { "session_date": "2026-08-27", "lift_type": "squat", "notes": "felt good",
//   "sets": [{ "set_number": 1, "weight_lb": 315, "reps": 5, "rpe": 8 }] }
app.post('/api/sessions', async (req, res) => {
  const { session_date, lift_type, notes, sets } = req.body;
 
  if (!session_date || !lift_type) {
    return res.status(400).json({ error: 'session_date and lift_type are required' });
  }
 
  try {
    const sessionResult = await pool.query(
      'INSERT INTO sessions (session_date, lift_type, notes) VALUES ($1, $2, $3) RETURNING *',
      [session_date, lift_type, notes || null]
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
    res.status(500).json({ error: 'Failed to create session', details: err.message });
  }
});
 
app.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});