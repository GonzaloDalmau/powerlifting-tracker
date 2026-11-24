// Copies every row from the remote Postgres (PG* vars in .env) into the local
// PGlite database in server/.localdb. The local tables are emptied first.
// Stop the local server before running:  node copy-remote-to-local.js
require('dotenv').config({ quiet: true });
const path = require('path');
const fs = require('fs');
const { Pool, types } = require('pg');
const { PGlite } = require('@electric-sql/pglite');

// keep DATE / TIMESTAMP as raw text so nothing shifts by timezone
types.setTypeParser(1082, (v) => v);
types.setTypeParser(1114, (v) => v);

// parents before children so foreign keys are satisfied
const TABLES = ['users', 'sessions', 'sets', 'weigh_ins', 'blocks'];

async function main() {
  if (!process.env.PGHOST) throw new Error('PGHOST not set in .env, nothing to copy from');

  const remote = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.PGPORT,
    ssl: { rejectUnauthorized: false },
  });
  const local = new PGlite(path.join(__dirname, '.localdb'));
  await local.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

  const data = {};
  for (const t of TABLES) data[t] = (await remote.query(`SELECT * FROM ${t} ORDER BY id`)).rows;
  await remote.end();

  await local.transaction(async (tx) => {
    await tx.exec(`TRUNCATE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
    for (const t of TABLES) {
      for (const row of data[t]) {
        const cols = Object.keys(row);
        const params = cols.map((_, i) => `$${i + 1}`).join(', ');
        await tx.query(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${params})`, Object.values(row));
      }
      // move the id counter past the copied ids so new rows don't collide
      await tx.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`);
    }
  });

  for (const t of TABLES) {
    const n = (await local.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n;
    console.log(`${t.padEnd(10)} remote ${String(data[t].length).padStart(3)}  local ${String(n).padStart(3)}`);
  }
  await local.close();
}

main().catch((err) => {
  console.error('Copy failed:', err.message);
  process.exit(1);
});
