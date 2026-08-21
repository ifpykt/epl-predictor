CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('admin', 'player')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
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

CREATE TABLE IF NOT EXISTS season_functions (
  user_id BIGINT NOT NULL,
  function_code TEXT NOT NULL CHECK (function_code IN (
    'DRAW_RAGE','GOAL_STREAK','CLEAN_SHEET','GAME_TOTAL',
    'ALL_IN','AWAY_VICTORY','UNDERDOGS_PRIME','BTTS'
  )),
  round INTEGER NOT NULL CHECK (round BETWEEN 1 AND 38),
  fixture_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, function_code),
  CHECK ((function_code IN ('GAME_TOTAL','ALL_IN') AND fixture_id IS NOT NULL)
    OR (function_code NOT IN ('GAME_TOTAL','ALL_IN') AND fixture_id IS NULL))
);
CREATE INDEX IF NOT EXISTS season_functions_round_idx ON season_functions(round,user_id);
CREATE UNIQUE INDEX IF NOT EXISTS season_functions_one_per_round_idx ON season_functions(user_id,round);

CREATE TABLE IF NOT EXISTS league_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  season_name TEXT NOT NULL DEFAULT 'АПЛ 2026/27',
  exact_points INTEGER NOT NULL DEFAULT 3 CHECK (exact_points BETWEEN 0 AND 20),
  difference_points INTEGER NOT NULL DEFAULT 2 CHECK (difference_points BETWEEN 0 AND 20),
  outcome_points INTEGER NOT NULL DEFAULT 1 CHECK (outcome_points BETWEEN 0 AND 20),
  joker_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rules_text TEXT NOT NULL DEFAULT 'Прогноз можно менять до начала матча. После стартового свистка прогнозы открываются всем участникам.',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO league_settings(id) VALUES(1) ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS app_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
WITH applied AS (
  INSERT INTO app_migrations(name)
  VALUES ('scoring_3_2_1')
  ON CONFLICT(name) DO NOTHING
  RETURNING name
)
UPDATE league_settings
SET exact_points = 3,
    difference_points = 2,
    outcome_points = 1,
    updated_at = NOW()
WHERE id = 1
  AND EXISTS (SELECT 1 FROM applied);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  actor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS dela_tasks (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','control','done')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','high','critical')),
  due_date TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dela_tasks_status_idx ON dela_tasks(status,due_date);

CREATE TABLE IF NOT EXISTS dela_news (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT,
  author TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS dela_history (
  id BIGSERIAL PRIMARY KEY,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dela_history_created_idx ON dela_history(created_at DESC);

CREATE TABLE IF NOT EXISTS dela_bot_drafts (
  id UUID PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task','news')),
  payload JSONB NOT NULL,
  actor_name TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 day',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
