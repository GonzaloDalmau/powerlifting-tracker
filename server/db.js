const { Pool } = require('pg');
 
const pool = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'powerlifting_tracker',
  password: 'LOCO123caga456!',
  port: 5432,
});
 
module.exports = pool;