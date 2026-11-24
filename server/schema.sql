-- Schema mirrored from the production Railway database (2026-11-23).
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_date DATE NOT NULL,
  lift_type    TEXT NOT NULL,
  notes        TEXT
);

CREATE TABLE IF NOT EXISTS sets (
  id         SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  set_number INTEGER NOT NULL,
  weight_lb  NUMERIC NOT NULL,
  reps       INTEGER NOT NULL,
  rpe        NUMERIC
);

CREATE TABLE IF NOT EXISTS weigh_ins (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weigh_date DATE NOT NULL,
  weight_kg  NUMERIC NOT NULL
);

CREATE TABLE IF NOT EXISTS blocks (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date   DATE,
  created_at TIMESTAMP DEFAULT now()
);
