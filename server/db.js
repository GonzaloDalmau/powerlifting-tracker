const fs = require('fs');
const path = require('path');

// DB_MODE:
//   "remote" (default when PGHOST is set) - real Postgres via PG* env vars
//   "local"  (default when PGHOST is not set) - embedded PGlite stored in server/.localdb
//   "memory" - embedded PGlite that lives only in memory (used by tests)
//   `node index.js --local` forces local mode even if .env has PGHOST.
const mode = process.argv.includes('--local')
  ? 'local'
  : process.env.DB_MODE || (process.env.PGHOST ? 'remote' : 'local');

let pool;

if (mode === 'remote') {
  const { Pool } = require('pg');
  pool = new Pool({
    user: process.env.PGUSER,
    host: process.env.PGHOST,
    database: process.env.PGDATABASE,
    password: process.env.PGPASSWORD,
    port: process.env.PGPORT,
    ssl: { rejectUnauthorized: false },
  });
} else {
  const { PGlite } = require('@electric-sql/pglite');
  const dataDir = mode === 'memory' ? undefined : path.join(__dirname, '.localdb');
  const db = new PGlite(dataDir);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  const ready = db.exec(schema);

  pool = {
    async query(text, params) {
      await ready;
      return db.query(text, params);
    },
    async end() {
      await ready;
      await db.close();
    },
  };
}

pool.mode = mode;
module.exports = pool;
