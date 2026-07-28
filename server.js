import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import express from "express";
import helmet from "helmet";
import { query, transaction } from "./db.js";

const app = express();
const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";
const cookieName = "apl_session";

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use(express.static(path.join(root, "public")));

function cleanLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function score(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 30 ? number : null;
}

async function auth(req, res, next) {
  const token = req.cookies[cookieName];
  if (!token) return res.status(401).json({ error: "Войдите в аккаунт" });
  const { rows } = await query(
    `SELECT u.id, u.login, u.display_name, u.role, u.must_change_password
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.id=$1 AND s.expires_at>NOW() AND u.active=TRUE`,
    [token],
  );
  if (!rows[0]) return res.status(401).json({ error: "Сессия истекла" });
  req.user = rows[0];
  next();
}

function admin(req, res, next) {
  if (req.user.role !== "admin") return res.status(403).json({ error: "Только для администратора" });
  next();
}

function points(prediction, fixture, settings = { exact_points: 5, difference_points: 3, outcome_points: 2 }) {
  if (fixture.home_score === null || fixture.away_score === null) return null;
  let value = 0;
  if (prediction.pred_home === fixture.home_score && prediction.pred_away === fixture.away_score) value = settings.exact_points;
  else if (prediction.pred_home - prediction.pred_away === fixture.home_score - fixture.away_score) value = settings.difference_points;
  else if (Math.sign(prediction.pred_home - prediction.pred_away) === Math.sign(fixture.home_score - fixture.away_score)) value = settings.outcome_points;
  return value * (prediction.bonus ? 2 : 1);
}

async function audit(user, action, targetType = null, targetId = null, details = {}) {
  await query(
    "INSERT INTO audit_log(actor_id,actor_name,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6)",
    [user.id, user.display_name, action, targetType, targetId == null ? null : String(targetId), JSON.stringify(details)],
  );
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/api/login", async (req, res) => {
  const login = cleanLogin(req.body.login);
  const { rows } = await query("SELECT * FROM users WHERE login=$1 AND active=TRUE", [login]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(String(req.body.password || ""), user.password_hash))) {
    return res.status(401).json({ error: "Неверный логин или пароль" });
  }
  const id = crypto.randomUUID();
  await query("INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,NOW()+INTERVAL '30 days')", [id, user.id]);
  await query("UPDATE users SET last_login_at=NOW() WHERE id=$1", [user.id]);
  res.cookie(cookieName, id, { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: 30 * 86400000 });
  res.json({ ok: true });
});

app.post("/api/logout", auth, async (req, res) => {
  await query("DELETE FROM sessions WHERE id=$1", [req.cookies[cookieName]]);
  res.clearCookie(cookieName);
  res.json({ ok: true });
});

app.get("/api/state", auth, async (req, res) => {
  const [fixtures, predictions, allPredictions, users, settings] = await Promise.all([
    query("SELECT * FROM fixtures ORDER BY round,kickoff"),
    query(`SELECT p.*,u.display_name FROM predictions p JOIN users u ON u.id=p.user_id
           JOIN fixtures f ON f.id=p.fixture_id WHERE p.user_id=$1 OR f.kickoff<=NOW()`, [req.user.id]),
    query("SELECT p.*,u.display_name FROM predictions p JOIN users u ON u.id=p.user_id WHERE u.active=TRUE"),
    query("SELECT id,login,display_name,role,active,must_change_password,last_login_at FROM users ORDER BY id"),
    query("SELECT * FROM league_settings WHERE id=1"),
  ]);
  const ranking = new Map();
  const fixtureMap = new Map(fixtures.rows.map((item) => [String(item.id), item]));
  for (const prediction of allPredictions.rows) {
    const result = points(
      { pred_home: prediction.home_score, pred_away: prediction.away_score, bonus: prediction.bonus },
      fixtureMap.get(String(prediction.fixture_id)), settings.rows[0],
    );
    if (result !== null) ranking.set(prediction.display_name, (ranking.get(prediction.display_name) || 0) + result);
  }
  res.json({
    user: req.user,
    fixtures: fixtures.rows,
    predictions: predictions.rows,
    users: req.user.role === "admin" ? users.rows : [],
    settings: settings.rows[0],
    ranking: [...ranking].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total),
  });
});

app.put("/api/predictions/:fixtureId", auth, async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  const home = score(req.body.homeScore);
  const away = score(req.body.awayScore);
  if (!fixtureId || home === null || away === null) return res.status(400).json({ error: "Проверьте счёт" });
  const { rows } = await query("SELECT round,kickoff FROM fixtures WHERE id=$1", [fixtureId]);
  const fixture = rows[0];
  if (!fixture) return res.status(404).json({ error: "Матч не найден" });
  if (new Date(fixture.kickoff) <= new Date()) return res.status(409).json({ error: "Матч уже начался" });
  if (req.body.bonus) {
    const { rows: settings } = await query("SELECT joker_enabled FROM league_settings WHERE id=1");
    if (!settings[0]?.joker_enabled) return res.status(409).json({ error: "Матч ×2 отключён в правилах лиги" });
  }
  await transaction(async (client) => {
    if (req.body.bonus) {
      await client.query(
        `UPDATE predictions SET bonus=FALSE WHERE user_id=$1 AND fixture_id IN
         (SELECT id FROM fixtures WHERE round=$2)`,
        [req.user.id, fixture.round],
      );
    }
    await client.query(
      `INSERT INTO predictions(user_id,fixture_id,home_score,away_score,bonus)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(user_id,fixture_id) DO UPDATE SET
       home_score=EXCLUDED.home_score,away_score=EXCLUDED.away_score,
       bonus=EXCLUDED.bonus,updated_at=NOW()`,
      [req.user.id, fixtureId, home, away, Boolean(req.body.bonus)],
    );
  });
  res.json({ ok: true });
});

app.post("/api/change-password", auth, async (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 8) return res.status(400).json({ error: "Минимум 8 символов" });
  await query("UPDATE users SET password_hash=$1,must_change_password=FALSE WHERE id=$2", [await bcrypt.hash(password, 12), req.user.id]);
  res.json({ ok: true });
});

app.post("/api/admin/users", auth, admin, async (req, res) => {
  const login = cleanLogin(req.body.login);
  const name = String(req.body.displayName || "").trim();
  const password = String(req.body.temporaryPassword || "");
  if (!/^[a-z0-9._-]{3,32}$/.test(login) || !name || password.length < 8) {
    return res.status(400).json({ error: "Проверьте имя, логин и пароль" });
  }
  const hash = await bcrypt.hash(password, 12);
  const created = await query(
    "INSERT INTO users(login,display_name,password_hash) VALUES($1,$2,$3) RETURNING id",
    [login, name, hash],
  );
  await audit(req.user, "Создан участник", "user", created.rows[0].id, { name, login });
  res.status(201).json({ ok: true });
});

app.patch("/api/admin/users/:id", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  await query("UPDATE users SET active=$1 WHERE id=$2 AND role<>'admin'", [Boolean(req.body.active), id]);
  await query("DELETE FROM sessions WHERE user_id=$1", [id]);
  await audit(req.user, req.body.active ? "Активирован участник" : "Архивирован участник", "user", id);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/reset-password", auth, admin, async (req, res) => {
  const password = String(req.body.temporaryPassword || "");
  const id = Number(req.params.id);
  if (password.length < 8) return res.status(400).json({ error: "Минимум 8 символов" });
  await query("UPDATE users SET password_hash=$1,must_change_password=TRUE WHERE id=$2 AND role<>'admin'", [await bcrypt.hash(password, 12), id]);
  await query("DELETE FROM sessions WHERE user_id=$1", [id]);
  await audit(req.user, "Выдан временный пароль", "user", id);
  res.json({ ok: true });
});

app.get("/api/admin/dashboard", auth, admin, async (_req, res) => {
  const [summary, users, predictions, logs, settings] = await Promise.all([
    query(`SELECT
      (SELECT COUNT(*) FROM fixtures)::int fixtures,
      (SELECT COUNT(*) FROM fixtures WHERE home_score IS NULL OR away_score IS NULL)::int pending_results,
      (SELECT COUNT(*) FROM users WHERE role='player' AND active=TRUE)::int active_players,
      (SELECT MAX(updated_at) FROM fixtures) last_sync`),
    query(`SELECT u.id,u.login,u.display_name,u.active,u.must_change_password,u.last_login_at,
      COUNT(p.fixture_id)::int predictions,
      COUNT(p.fixture_id) FILTER (WHERE f.kickoff>NOW())::int upcoming_predictions
      FROM users u LEFT JOIN predictions p ON p.user_id=u.id
      LEFT JOIN fixtures f ON f.id=p.fixture_id
      WHERE u.role='player' GROUP BY u.id ORDER BY u.display_name`),
    query(`SELECT p.fixture_id,p.user_id,p.home_score,p.away_score,p.bonus,p.updated_at,u.display_name
      FROM predictions p JOIN users u ON u.id=p.user_id
      WHERE u.role='player' AND u.active=TRUE
      ORDER BY p.fixture_id,u.display_name`),
    query("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100"),
    query("SELECT * FROM league_settings WHERE id=1"),
  ]);
  res.json({
    summary: summary.rows[0],
    users: users.rows,
    predictions: predictions.rows,
    logs: logs.rows,
    settings: settings.rows[0],
  });
});

app.patch("/api/admin/fixtures/:id", auth, admin, async (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body.reason || "").trim();
  if (reason.length < 5) return res.status(400).json({ error: "Укажите причину изменения" });
  const kickoff = new Date(req.body.kickoff);
  const scoreIsBlank = req.body.homeScore === "" && req.body.awayScore === "";
  const home = scoreIsBlank ? null : score(req.body.homeScore);
  const away = scoreIsBlank ? null : score(req.body.awayScore);
  if (Number.isNaN(kickoff.getTime()) || (!scoreIsBlank && (home === null || away === null))) return res.status(400).json({ error: "Проверьте дату и результат" });
  await query("UPDATE fixtures SET kickoff=$1,status=$2,home_score=$3,away_score=$4,updated_at=NOW() WHERE id=$5",
    [kickoff, String(req.body.status || "SCHEDULED"), home, away, id]);
  await audit(req.user, "Изменён матч вручную", "fixture", id, { reason, kickoff, status: req.body.status, score: home === null ? null : `${home}:${away}` });
  res.json({ ok: true });
});

app.patch("/api/admin/settings", auth, admin, async (req, res) => {
  const values = ["exactPoints", "differencePoints", "outcomePoints"].map((key) => Number(req.body[key]));
  if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 20)) return res.status(400).json({ error: "Очки должны быть от 0 до 20" });
  const started = await query("SELECT EXISTS(SELECT 1 FROM fixtures WHERE kickoff<=NOW()) value");
  if (started.rows[0].value && !req.body.confirmRecalculate) return res.status(409).json({ error: "Сезон уже начался. Подтвердите пересчёт всего сезона." });
  await query(`UPDATE league_settings SET season_name=$1,exact_points=$2,difference_points=$3,outcome_points=$4,
    joker_enabled=$5,rules_text=$6,updated_at=NOW() WHERE id=1`,
  [String(req.body.seasonName || "").trim() || "АПЛ", ...values, Boolean(req.body.jokerEnabled), String(req.body.rulesText || "").trim()]);
  await audit(req.user, "Изменены правила лиги", "settings", 1, { scoring: values, joker: Boolean(req.body.jokerEnabled) });
  res.json({ ok: true });
});

app.post("/api/admin/sync", auth, admin, async (req, res) => {
  const updated = await syncMatches();
  await audit(req.user, "Синхронизированы матчи", "fixtures", null, { updated });
  res.json({ ok: true, updated });
});

app.post("/api/cron/sync", async (req, res) => {
  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) return res.sendStatus(401);
  const updated = await syncMatches();
  res.json({ ok: true, updated });
});

async function syncMatches() {
  if (!process.env.FOOTBALL_DATA_API_KEY) throw new Error("FOOTBALL_DATA_API_KEY is not configured");
  const season = process.env.SEASON || "2026";
  const response = await fetch(`https://api.football-data.org/v4/competitions/PL/matches?season=${season}`, {
    headers: { "X-Auth-Token": process.env.FOOTBALL_DATA_API_KEY },
  });
  if (!response.ok) throw new Error(`Results provider returned ${response.status}`);
  const data = await response.json();
  let updated = 0;
  for (const match of data.matches || []) {
    const round = Number(String(match.matchday || "0").replace(/\D/g, ""));
    await query(
      `INSERT INTO fixtures(id,round,kickoff,status,home_name,away_name,home_crest,away_crest,home_score,away_score)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(id) DO UPDATE SET round=EXCLUDED.round,kickoff=EXCLUDED.kickoff,status=EXCLUDED.status,
       home_name=EXCLUDED.home_name,away_name=EXCLUDED.away_name,home_crest=EXCLUDED.home_crest,
       away_crest=EXCLUDED.away_crest,home_score=EXCLUDED.home_score,away_score=EXCLUDED.away_score,updated_at=NOW()`,
      [match.id, round, match.utcDate, match.status, match.homeTeam.name, match.awayTeam.name,
       match.homeTeam.crest, match.awayTeam.crest, match.score?.fullTime?.home ?? null, match.score?.fullTime?.away ?? null],
    );
    updated += 1;
  }
  return updated;
}

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.code === "23505" ? 409 : 500).json({ error: error.code === "23505" ? "Такой логин уже существует" : "Ошибка сервера" });
});

app.get("*splat", (_req, res) => res.sendFile(path.join(root, "public", "index.html")));
app.listen(port, "0.0.0.0", () => console.log(`APL Predictor listening on ${port}`));
