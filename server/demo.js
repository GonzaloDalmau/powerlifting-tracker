// "Try demo": every visitor gets their own throwaway user pre-filled with
// ~16 weeks of sample training, so nobody sees or edits anyone else's demo.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DEMO_DOMAIN = 'demo.liftlog.invalid';
const DEMO_TTL_HOURS = 24;
const WEEKS = 16;

function isDemoEmail(email) {
  return typeof email === 'string' && email.endsWith('@' + DEMO_DOMAIN);
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const round5 = (lb) => Math.round(lb / 5) * 5;

// Linear progression with a deload every 4th week. Returns the sets for one session.
function setsFor(lift, week) {
  const start = { squat: 285, bench: 190, deadlift: 365 }[lift];
  const step = { squat: 5, bench: 2.5, deadlift: 7.5 }[lift];
  const deload = week % 4 === 3 && week !== WEEKS - 1;
  const top = round5(start + step * week) * (deload ? 0.85 : 1);
  const topSet = round5(top);
  // peak week: a heavy single for a real PR
  if (week === WEEKS - 1) {
    return [
      { weight_lb: round5(topSet * 0.85), reps: 3, rpe: 6 },
      { weight_lb: round5(topSet * 0.95), reps: 1, rpe: 7.5 },
      { weight_lb: round5(topSet * 1.08), reps: 1, rpe: 9.5 },
    ];
  }
  const reps = deload ? 5 : week < 8 ? 6 : 4;
  return [
    { weight_lb: topSet, reps, rpe: deload ? 6 : 8 },
    { weight_lb: round5(topSet * 0.9), reps, rpe: deload ? 5.5 : 7.5 },
    { weight_lb: round5(topSet * 0.9), reps, rpe: deload ? 5.5 : 8 },
  ];
}

async function deleteExpiredDemoUsers(pool) {
  await pool.query(
    `DELETE FROM users WHERE email LIKE $1 AND created_at < now() - ($2 || ' hours')::interval`,
    ['%@' + DEMO_DOMAIN, String(DEMO_TTL_HOURS)]
  );
}

async function createDemoUser(pool) {
  await deleteExpiredDemoUsers(pool);

  const email = `demo-${crypto.randomUUID()}@${DEMO_DOMAIN}`;
  // unguessable password: the demo account can only be reached through its token
  const hash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 8);
  const user = (await pool.query(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id',
    [email, hash]
  )).rows[0];

  // blocks: a finished volume block, then the current strength block
  const daysAgoStart = WEEKS * 7;
  const half = Math.floor(WEEKS / 2) * 7;
  await pool.query(
    `INSERT INTO blocks (user_id, name, start_date, end_date) VALUES
       ($1, 'Volume block', $2, $3),
       ($1, 'Strength block - meet prep', $4, NULL)`,
    [user.id, isoDaysAgo(daysAgoStart), isoDaysAgo(half + 1), isoDaysAgo(half)]
  );

  // sessions: squat / bench / deadlift on days 0 / 2 / 4 of each week
  const plan = [];
  for (let week = 0; week < WEEKS; week++) {
    ['squat', 'bench', 'deadlift'].forEach((lift, i) => {
      const daysAgo = daysAgoStart - (week * 7 + i * 2);
      if (daysAgo >= 0) plan.push({ date: isoDaysAgo(daysAgo), lift, sets: setsFor(lift, week) });
    });
  }

  const sessionValues = plan.map((_, i) => `($1, $${i * 2 + 2}, $${i * 2 + 3})`).join(', ');
  const sessionRows = (await pool.query(
    `INSERT INTO sessions (user_id, session_date, lift_type) VALUES ${sessionValues}
     RETURNING id, session_date::text AS d, lift_type`,
    [user.id, ...plan.flatMap((p) => [p.date, p.lift])]
  )).rows;
  const idByKey = new Map(sessionRows.map((r) => [`${r.d.slice(0, 10)}|${r.lift_type}`, r.id]));

  const setParams = [];
  const setValues = [];
  plan.forEach((p) => {
    const sessionId = idByKey.get(`${p.date}|${p.lift}`);
    p.sets.forEach((s, i) => {
      const n = setParams.length;
      setValues.push(`($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5})`);
      setParams.push(sessionId, i + 1, s.weight_lb, s.reps, s.rpe);
    });
  });
  await pool.query(
    `INSERT INTO sets (session_id, set_number, weight_lb, reps, rpe) VALUES ${setValues.join(', ')}`,
    setParams
  );

  // weekly weigh-ins drifting down toward the 93 kg class
  const weighValues = [];
  const weighParams = [user.id];
  for (let week = 0; week < WEEKS; week++) {
    const kg = Math.round((97.2 - week * 0.22 + (week % 3) * 0.15) * 10) / 10;
    weighValues.push(`($1, $${weighParams.length + 1}, $${weighParams.length + 2})`);
    weighParams.push(isoDaysAgo(daysAgoStart - week * 7), kg);
  }
  await pool.query(
    `INSERT INTO weigh_ins (user_id, weigh_date, weight_kg) VALUES ${weighValues.join(', ')}`,
    weighParams
  );

  return user;
}

module.exports = { createDemoUser, deleteExpiredDemoUsers, isDemoEmail, DEMO_DOMAIN, DEMO_TTL_HOURS };
