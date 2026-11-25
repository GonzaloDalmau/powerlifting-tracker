// API tests. Runs against a throwaway in-memory database, never the real one.
process.env.DB_MODE = 'memory';
process.env.PGHOST = '';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const app = require('../index');
const pool = require('../db');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

async function api(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

async function newUser(email, password = 'pass1234') {
  const reg = await api('POST', '/api/register', { body: { email, password } });
  assert.equal(reg.status, 201);
  const login = await api('POST', '/api/login', { body: { email, password } });
  assert.equal(login.status, 200);
  return login.body.token;
}

test('frontend is served at /', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html/i);
});

test('register: validation and duplicate email', async () => {
  assert.equal((await api('POST', '/api/register', { body: { email: 'x@x.com' } })).status, 400);
  const first = await api('POST', '/api/register', { body: { email: 'dup@x.com', password: 'a' } });
  assert.equal(first.status, 201);
  assert.equal(first.body.email, 'dup@x.com');
  assert.equal(first.body.password_hash, undefined, 'hash must not leak');
  const second = await api('POST', '/api/register', { body: { email: 'dup@x.com', password: 'a' } });
  assert.equal(second.status, 500);
});

test('login: wrong password and unknown user', async () => {
  await newUser('login@x.com', 'right');
  assert.equal((await api('POST', '/api/login', { body: { email: 'login@x.com', password: 'wrong' } })).status, 400);
  assert.equal((await api('POST', '/api/login', { body: { email: 'nobody@x.com', password: 'x' } })).status, 400);
});

test('protected routes reject missing or bad tokens', async () => {
  assert.equal((await api('GET', '/api/sessions')).status, 401);
  assert.equal((await api('GET', '/api/sessions', { token: 'garbage' })).status, 403);
});

test('sessions: create with sets, list, delete', async () => {
  const token = await newUser('sess@x.com');
  assert.equal((await api('POST', '/api/sessions', { token, body: { lift_type: 'squat' } })).status, 400);

  const created = await api('POST', '/api/sessions', {
    token,
    body: {
      session_date: '2026-11-20',
      lift_type: 'squat',
      notes: 'felt good',
      sets: [
        { set_number: 1, weight_lb: 315, reps: 5, rpe: 7 },
        { set_number: 2, weight_lb: 335, reps: 3 },
      ],
    },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.sets.length, 2);
  assert.equal(created.body.sets[1].rpe, null);

  const list = await api('GET', '/api/sessions', { token });
  assert.equal(list.status, 200);
  assert.equal(list.body.length, 1);
  assert.deepEqual(list.body[0].sets.map((s) => s.set_number), [1, 2]);

  const del = await api('DELETE', `/api/sessions/${created.body.id}`, { token });
  assert.equal(del.status, 200);
  assert.equal((await api('DELETE', `/api/sessions/${created.body.id}`, { token })).status, 404);
  assert.equal((await api('GET', '/api/sessions', { token })).body.length, 0);
});

test('users cannot see or delete each other\'s data', async () => {
  const a = await newUser('a@x.com');
  const b = await newUser('b@x.com');
  const s = await api('POST', '/api/sessions', { token: a, body: { session_date: '2026-11-01', lift_type: 'bench', sets: [] } });
  const blk = await api('POST', '/api/blocks', { token: a, body: { name: 'Peak', start_date: '2026-11-01' } });

  assert.equal((await api('GET', '/api/sessions', { token: b })).body.length, 0);
  assert.equal((await api('DELETE', `/api/sessions/${s.body.id}`, { token: b })).status, 404);
  assert.equal((await api('DELETE', `/api/blocks/${blk.body.id}`, { token: b })).status, 404);
  assert.equal((await api('GET', '/api/sessions', { token: a })).body.length, 1);
});

test('weigh-ins: create and list in date order', async () => {
  const token = await newUser('weigh@x.com');
  assert.equal((await api('POST', '/api/weigh-ins', { token, body: { weigh_date: '2026-11-01' } })).status, 400);
  await api('POST', '/api/weigh-ins', { token, body: { weigh_date: '2026-11-10', weight_kg: 93.4 } });
  await api('POST', '/api/weigh-ins', { token, body: { weigh_date: '2026-11-01', weight_kg: 92.1 } });
  const list = await api('GET', '/api/weigh-ins', { token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((w) => Number(w.weight_kg)), [92.1, 93.4]);
});

test('blocks: create, list, delete', async () => {
  const token = await newUser('block@x.com');
  assert.equal((await api('POST', '/api/blocks', { token, body: { name: 'x' } })).status, 400);
  const b = await api('POST', '/api/blocks', { token, body: { name: 'Hypertrophy', start_date: '2026-10-01', end_date: '2026-10-28' } });
  assert.equal(b.status, 201);
  assert.equal((await api('GET', '/api/blocks', { token })).body.length, 1);
  assert.equal((await api('DELETE', `/api/blocks/${b.body.id}`, { token })).status, 200);
  assert.equal((await api('GET', '/api/blocks', { token })).body.length, 0);
});

test('PRs: heaviest set per lift, more reps then earliest date on ties', async () => {
  const token = await newUser('pr@x.com');
  const log = (date, lift, weights) =>
    api('POST', '/api/sessions', {
      token,
      body: { session_date: date, lift_type: lift, sets: weights.map((w, i) => ({ set_number: i + 1, weight_lb: w, reps: 1 })) },
    });
  await log('2026-11-01', 'squat', [400, 405]);
  await log('2026-11-08', 'squat', [405, 395]);
  await log('2026-11-02', 'deadlift', [500]);
  // same weight for more reps is the better set
  await api('POST', '/api/sessions', {
    token,
    body: { session_date: '2026-11-03', lift_type: 'bench', sets: [{ set_number: 1, weight_lb: 300, reps: 1 }] },
  });
  await api('POST', '/api/sessions', {
    token,
    body: { session_date: '2026-11-09', lift_type: 'bench', sets: [{ set_number: 1, weight_lb: 300, reps: 3 }] },
  });

  const prs = await api('GET', '/api/prs', { token });
  assert.equal(prs.status, 200);
  const byLift = Object.fromEntries(prs.body.map((p) => [p.lift_type, p]));
  assert.equal(Number(byLift.squat.weight_lb), 405);
  assert.equal(new Date(byLift.squat.session_date).toISOString().slice(0, 10), '2026-11-01');
  assert.equal(Number(byLift.deadlift.weight_lb), 500);
  assert.equal(byLift.bench.reps, 3);
});

test('change password', async () => {
  const token = await newUser('pw@x.com', 'old');
  assert.equal((await api('POST', '/api/change-password', { token, body: { currentPassword: 'nope', newPassword: 'new' } })).status, 400);
  assert.equal((await api('POST', '/api/change-password', { token, body: { currentPassword: 'old', newPassword: 'new' } })).status, 200);
  assert.equal((await api('POST', '/api/login', { body: { email: 'pw@x.com', password: 'old' } })).status, 400);
  assert.equal((await api('POST', '/api/login', { body: { email: 'pw@x.com', password: 'new' } })).status, 200);
});

test('reset data keeps the account but wipes everything else', async () => {
  const token = await newUser('reset@x.com');
  await api('POST', '/api/sessions', { token, body: { session_date: '2026-11-01', lift_type: 'bench', sets: [{ set_number: 1, weight_lb: 225, reps: 5 }] } });
  await api('POST', '/api/weigh-ins', { token, body: { weigh_date: '2026-11-01', weight_kg: 90 } });
  await api('POST', '/api/blocks', { token, body: { name: 'b', start_date: '2026-11-01' } });

  assert.equal((await api('DELETE', '/api/reset-data', { token })).status, 200);
  for (const p of ['/api/sessions', '/api/weigh-ins', '/api/blocks', '/api/prs']) {
    assert.equal((await api('GET', p, { token })).body.length, 0, p);
  }
  assert.equal((await api('POST', '/api/login', { body: { email: 'reset@x.com', password: 'pass1234' } })).status, 200);
});

test('delete account requires password and cascades', async () => {
  const token = await newUser('gone@x.com');
  await api('POST', '/api/sessions', { token, body: { session_date: '2026-11-01', lift_type: 'squat', sets: [{ set_number: 1, weight_lb: 1, reps: 1 }] } });
  assert.equal((await api('DELETE', '/api/account', { token, body: {} })).status, 400);
  assert.equal((await api('DELETE', '/api/account', { token, body: { password: 'wrong' } })).status, 400);
  assert.equal((await api('DELETE', '/api/account', { token, body: { password: 'pass1234' } })).status, 200);
  assert.equal((await api('POST', '/api/login', { body: { email: 'gone@x.com', password: 'pass1234' } })).status, 400);
  const mine = await pool.query("SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'gone@x.com'");
  assert.equal(mine.rows[0].n, 0);
});

test('demo: creates an isolated account with sample data', async () => {
  const a = await api('POST', '/api/demo');
  assert.equal(a.status, 201);
  assert.equal(a.body.demo, true);
  const token = a.body.token;

  const sessions = (await api('GET', '/api/sessions', { token })).body;
  assert.ok(sessions.length >= 40, `expected sample sessions, got ${sessions.length}`);
  assert.ok(sessions.every((s) => s.sets.length > 0));
  assert.deepEqual([...new Set(sessions.map((s) => s.lift_type))].sort(), ['bench', 'deadlift', 'squat']);

  const blocks = (await api('GET', '/api/blocks', { token })).body;
  assert.equal(blocks.length, 2);
  assert.equal(blocks.filter((b) => b.end_date === null).length, 1, 'one ongoing block');

  assert.ok((await api('GET', '/api/weigh-ins', { token })).body.length > 0);
  assert.equal((await api('GET', '/api/prs', { token })).body.length, 3);

  // a second visitor gets a separate account; changes in one never show in the other
  const b = (await api('POST', '/api/demo')).body.token;
  await api('DELETE', '/api/reset-data', { token: b });
  assert.equal((await api('GET', '/api/sessions', { token: b })).body.length, 0);
  assert.equal((await api('GET', '/api/sessions', { token })).body.length, sessions.length);
});

test('demo: expired demo users are cleaned up, real users are not', async () => {
  const { DEMO_DOMAIN } = require('../demo');
  const realToken = await newUser('keepme@x.com');
  const old = (await api('POST', '/api/demo')).body;
  await pool.query(`UPDATE users SET created_at = now() - interval '2 days' WHERE id = $1`, [old.userId]);
  await pool.query(`UPDATE users SET created_at = now() - interval '2 days' WHERE email = 'keepme@x.com'`);

  await api('POST', '/api/demo'); // triggers cleanup
  const gone = await pool.query('SELECT 1 FROM users WHERE id = $1', [old.userId]);
  assert.equal(gone.rows.length, 0);
  assert.equal((await api('GET', '/api/sessions', { token: realToken })).status, 200);
  const kept = await pool.query(`SELECT 1 FROM users WHERE email = 'keepme@x.com'`);
  assert.equal(kept.rows.length, 1);

  // nobody can register into the demo domain and get swept up by cleanup
  const reg = await api('POST', '/api/register', { body: { email: `me@${DEMO_DOMAIN}`, password: 'x' } });
  assert.equal(reg.status, 400);
});
