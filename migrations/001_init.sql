CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('admin', 'player')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS fixtures (
  id BIGINT PRIMARY KEY,
  round INTEGER NOT NULL,
  kickoff TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'SCHEDULED',
  home_name TEXT NOT NULL,
  away_name TEXT NOT NULL,
  home_crest TEXT,
  away_crest TEXT,
  home_score INTEGER,
  away_score INTEGER,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS fixtures_round_idx ON fixtures(round, kickoff);

CREATE TABLE IF NOT EXISTS predictions (
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fixture_id BIGINT NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  home_score INTEGER NOT NULL CHECK (home_score BETWEEN 0 AND 30),
  away_score INTEGER NOT NULL CHECK (away_score BETWEEN 0 AND 30),
  bonus BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, fixture_id)
);
