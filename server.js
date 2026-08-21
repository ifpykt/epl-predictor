import crypto from "node:crypto";
import https from "node:https";
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
const delaStatuses = new Set(["new", "in_progress", "control", "done"]);
const delaPriorities = new Set(["normal", "high", "critical"]);
const seasonFunctionCodes = new Set([
  "DRAW_RAGE", "GOAL_STREAK", "CLEAN_SHEET", "GAME_TOTAL",
  "ALL_IN", "AWAY_VICTORY", "UNDERDOGS_PRIME", "BTTS",
]);
const matchFunctionCodes = new Set(["GAME_TOTAL", "ALL_IN"]);

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "100kb" }));
app.use(cookieParser());
app.use(express.static(path.join(root, "public")));

function cleanLogin(value) {
  return String(value || "").trim().toLowerCase();
}

function isCompetitionUser(user) {
  return Boolean(user?.active) && user.role === "player" && cleanLogin(user.login) !== "test";
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

function canUseDela(user) {
  const allowed = String(process.env.DELA_ALLOWED_LOGINS || "admin")
    .split(",").map(cleanLogin).filter(Boolean);
  return user.role === "admin" || allowed.includes(cleanLogin(user.login));
}

function delaAccess(req, res, next) {
  if (!canUseDela(req.user)) return res.status(403).json({ error: "Нет доступа к разделу «Дела»" });
  next();
}

async function delaAudit(actor, action, entityType, entityId, details = {}) {
  await query(
    `INSERT INTO dela_history(actor_name,action,entity_type,entity_id,details)
     VALUES($1,$2,$3,$4,$5)`,
    [actor, action, entityType, entityId == null ? null : String(entityId), JSON.stringify(details)],
  );
}

function cleanTask(body) {
  const title = String(body.title || "").trim();
  const description = String(body.description || "").trim();
  const status = delaStatuses.has(body.status) ? body.status : "new";
  const priority = delaPriorities.has(body.priority) ? body.priority : "normal";
  const dueDate = body.dueDate ? new Date(body.dueDate) : null;
  if (!title || title.length > 180) throw Object.assign(new Error("Укажите название задачи"), { status: 400 });
  if (dueDate && Number.isNaN(dueDate.getTime())) throw Object.assign(new Error("Проверьте срок"), { status: 400 });
  return { title, description, status, priority, dueDate };
}

function points(prediction, fixture, settings = { exact_points: 3, difference_points: 2, outcome_points: 1 }) {
  if (fixture.home_score === null || fixture.away_score === null) return null;
  let value = 0;
  if (prediction.pred_home === fixture.home_score && prediction.pred_away === fixture.away_score) value = settings.exact_points;
  else if (prediction.pred_home - prediction.pred_away === fixture.home_score - fixture.away_score) value = settings.difference_points;
  else if (Math.sign(prediction.pred_home - prediction.pred_away) === Math.sign(fixture.home_score - fixture.away_score)) value = settings.outcome_points;
  return value * (prediction.bonus ? 2 : 1);
}

function standingsBeforeRound(fixtures, targetRound) {
  const rows = new Map();
  const team = (name) => {
    if (!rows.has(name)) rows.set(name, { name, points: 0, gd: 0, gf: 0 });
    return rows.get(name);
  };
  for (const fixture of fixtures) {
    if (Number(fixture.round) >= Number(targetRound) || fixture.home_score === null || fixture.away_score === null) continue;
    const home = team(fixture.home_name);
    const away = team(fixture.away_name);
    home.gf += fixture.home_score; away.gf += fixture.away_score;
    home.gd += fixture.home_score - fixture.away_score;
    away.gd += fixture.away_score - fixture.home_score;
    if (fixture.home_score > fixture.away_score) home.points += 3;
    else if (fixture.home_score < fixture.away_score) away.points += 3;
    else { home.points += 1; away.points += 1; }
  }
  return new Map([...rows.values()]
    .sort((a, b) => b.points - a.points || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name, "ru"))
    .map((item, index) => [item.name, index + 1]));
}

function selectionBonusBreakdown(selection, predictions, fixtures, settings) {
  const roundFixtures = fixtures.filter((fixture) => Number(fixture.round) === Number(selection.round));
  const fixtureMap = new Map(roundFixtures.map((fixture) => [String(fixture.id), fixture]));
  const roundPredictions = predictions.filter((prediction) => fixtureMap.has(String(prediction.fixture_id)));
  const completed = roundPredictions.filter((prediction) => {
    const fixture = fixtureMap.get(String(prediction.fixture_id));
    return fixture.home_score !== null && fixture.away_score !== null;
  });
  const breakdown = new Map();
  const set = (prediction, value) => breakdown.set(String(prediction.fixture_id), value);
  const code = selection.function_code;

  if (code === "DRAW_RAGE") {
    completed.forEach((prediction) => {
      const fixture = fixtureMap.get(String(prediction.fixture_id));
      set(prediction, prediction.home_score === prediction.away_score && fixture.home_score === fixture.away_score ? 2 : 0);
    });
    return breakdown;
  }
  if (code === "GOAL_STREAK") {
    completed.forEach((prediction) => {
      const fixture = fixtureMap.get(String(prediction.fixture_id));
      set(prediction, (Math.min(prediction.home_score, fixture.home_score) + Math.min(prediction.away_score, fixture.away_score)) * 0.5);
    });
    return breakdown;
  }
  if (code === "CLEAN_SHEET") {
    completed.forEach((prediction) => {
      const fixture = fixtureMap.get(String(prediction.fixture_id));
      set(prediction, (prediction.home_score === 0 && fixture.home_score === 0 ? 2 : 0)
        + (prediction.away_score === 0 && fixture.away_score === 0 ? 2 : 0));
    });
    return breakdown;
  }
  if (code === "AWAY_VICTORY") {
    completed.forEach((prediction) => {
      const fixture = fixtureMap.get(String(prediction.fixture_id));
      set(prediction, prediction.home_score < prediction.away_score && fixture.home_score < fixture.away_score ? 2 : 0);
    });
    return breakdown;
  }
  if (code === "BTTS") {
    completed.forEach((prediction) => {
      const fixture = fixtureMap.get(String(prediction.fixture_id));
      set(prediction, prediction.home_score > 0 && prediction.away_score > 0
        && fixture.home_score > 0 && fixture.away_score > 0 ? 1.5 : 0);
    });
    return breakdown;
  }
  if (code === "UNDERDOGS_PRIME") {
    if (Number(selection.round) < 15) return breakdown;
    const positions = standingsBeforeRound(fixtures, selection.round);
    completed.forEach((prediction) => {
      const fixture = fixtureMap.get(String(prediction.fixture_id));
      const homePos = positions.get(fixture.home_name);
      const awayPos = positions.get(fixture.away_name);
      if (!homePos || !awayPos || homePos === awayPos) return set(prediction, 0);
      const underdogHome = homePos > awayPos;
      const predictedUnderdogWin = underdogHome
        ? prediction.home_score > prediction.away_score : prediction.away_score > prediction.home_score;
      const actualUnderdogWin = underdogHome
        ? fixture.home_score > fixture.away_score : fixture.away_score > fixture.home_score;
      if (predictedUnderdogWin && actualUnderdogWin) return set(prediction, 2);
      if (prediction.home_score === prediction.away_score && fixture.home_score === fixture.away_score) return set(prediction, 1);
      return set(prediction, 0);
    });
    return breakdown;
  }

  const prediction = roundPredictions.find((item) => String(item.fixture_id) === String(selection.fixture_id));
  const fixture = fixtureMap.get(String(selection.fixture_id));
  if (!prediction || !fixture || fixture.home_score === null || fixture.away_score === null) return breakdown;
  if (code === "GAME_TOTAL") {
    const bothTeamsWithinRange = Math.abs(prediction.home_score - fixture.home_score) <= 2
      && Math.abs(prediction.away_score - fixture.away_score) <= 2;
    set(prediction, bothTeamsWithinRange ? fixture.home_score + fixture.away_score : 0);
  }
  if (code === "ALL_IN") {
    const exact = prediction.home_score === fixture.home_score && prediction.away_score === fixture.away_score;
    set(prediction, exact ? roundPredictions.reduce((sum, item) => sum + (points(
      { pred_home: item.home_score, pred_away: item.away_score },
      fixtureMap.get(String(item.fixture_id)),
      settings,
    ) || 0), 0) : -6);
  }
  return breakdown;
}

function selectionBonus(selection, predictions, fixtures, settings) {
  return [...selectionBonusBreakdown(selection, predictions, fixtures, settings).values()]
    .reduce((sum, value) => sum + value, 0);
}

function predictionPotential(code, prediction, fixture, fixtures, round) {
  if (!prediction) return false;
  if (code === "GOAL_STREAK") return true;
  if (code === "DRAW_RAGE") return prediction.home_score === prediction.away_score;
  if (code === "CLEAN_SHEET") return prediction.home_score === 0 || prediction.away_score === 0;
  if (code === "AWAY_VICTORY") return prediction.home_score < prediction.away_score;
  if (code === "BTTS") return prediction.home_score > 0 && prediction.away_score > 0;
  if (code === "UNDERDOGS_PRIME") {
    const positions = standingsBeforeRound(fixtures, round);
    const homePos = positions.get(fixture.home_name);
    const awayPos = positions.get(fixture.away_name);
    if (!homePos || !awayPos || homePos === awayPos) return false;
    const underdogHome = homePos > awayPos;
    return prediction.home_score === prediction.away_score
      || (underdogHome ? prediction.home_score > prediction.away_score : prediction.away_score > prediction.home_score);
  }
  return false;
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
  const [fixtures, predictions, allPredictions, users, settings, functions] = await Promise.all([
    query("SELECT * FROM fixtures ORDER BY round,kickoff"),
    query(`SELECT p.*,u.display_name FROM predictions p JOIN users u ON u.id=p.user_id
           JOIN fixtures f ON f.id=p.fixture_id
           WHERE p.user_id=$1 OR (u.active=TRUE AND u.role='player' AND LOWER(u.login)<>'test'
             AND f.kickoff<=NOW() AND f.status NOT IN ('POSTPONED','CANCELLED'))`, [req.user.id]),
    query("SELECT p.*,u.display_name FROM predictions p JOIN users u ON u.id=p.user_id WHERE u.active=TRUE AND u.role='player' AND LOWER(u.login)<>'test'"),
    query("SELECT id,login,display_name,role,active,must_change_password,last_login_at FROM users ORDER BY id"),
    query("SELECT * FROM league_settings WHERE id=1"),
    query("SELECT * FROM season_functions ORDER BY created_at"),
  ]);
  const ranking = new Map();
  const fixtureMap = new Map(fixtures.rows.map((item) => [String(item.id), item]));
  const functionPoints = new Map();
  const createRankingItem = (name) => ({ name, base: 0, bonus: 0, total: 0, rounds: {} });
  const roundLine = (item, fixtureRound) => {
    const key = String(fixtureRound);
    if (!item.rounds[key]) item.rounds[key] = { base: 0, bonus: 0, total: 0 };
    return item.rounds[key];
  };
  const competitionUserIds = new Set(users.rows.filter(isCompetitionUser).map((user) => String(user.id)));
  users.rows.filter(isCompetitionUser).forEach((user) => {
    if (!ranking.has(user.display_name)) ranking.set(user.display_name, createRankingItem(user.display_name));
  });
  for (const prediction of allPredictions.rows) {
    const fixture = fixtureMap.get(String(prediction.fixture_id));
    const result = points(
      { pred_home: prediction.home_score, pred_away: prediction.away_score, bonus: prediction.bonus },
      fixture,
      settings.rows[0],
    );
    if (result !== null) {
      const item = ranking.get(prediction.display_name) || createRankingItem(prediction.display_name);
      const line = roundLine(item, fixture.round);
      item.base += result;
      item.total += result;
      line.base += result;
      line.total += result;
      ranking.set(prediction.display_name, item);
    }
  }
  for (const selection of functions.rows) {
    if (!competitionUserIds.has(String(selection.user_id))) continue;
    const userPredictions = allPredictions.rows.filter((prediction) => String(prediction.user_id) === String(selection.user_id));
    const user = userPredictions[0]?.display_name
      || users.rows.find((item) => String(item.id) === String(selection.user_id))?.display_name;
    if (!user) continue;
    const breakdown = selectionBonusBreakdown(selection, userPredictions, fixtures.rows, settings.rows[0]);
    const bonus = [...breakdown.values()].reduce((sum, value) => sum + value, 0);
    const item = ranking.get(user) || createRankingItem(user);
    const line = roundLine(item, selection.round);
    item.bonus += bonus;
    item.total += bonus;
    line.bonus += bonus;
    line.total += bonus;
    ranking.set(user, item);
    for (const [fixtureId, value] of breakdown) {
      const key = `${selection.user_id}:${fixtureId}`;
      functionPoints.set(key, (functionPoints.get(key) || 0) + value);
    }
  }
  const scoredPredictions = predictions.rows.map((prediction) => {
    const fixture = fixtureMap.get(String(prediction.fixture_id));
    const basePoints = points(
      { pred_home: prediction.home_score, pred_away: prediction.away_score, bonus: prediction.bonus },
      fixture,
      settings.rows[0],
    );
    const bonusPoints = functionPoints.get(`${prediction.user_id}:${prediction.fixture_id}`) || 0;
    return {
      ...prediction,
      base_points: basePoints,
      function_points: basePoints === null ? null : bonusPoints,
      total_points: basePoints === null ? null : basePoints + bonusPoints,
    };
  });
  const ownFunctions = functions.rows.filter((item) => String(item.user_id) === String(req.user.id));
  const ownPredictions = predictions.rows.filter((item) => String(item.user_id) === String(req.user.id));
  const startedRounds = new Set(fixtures.rows
    .filter((fixture) => new Date(fixture.kickoff) <= new Date() && !["POSTPONED", "CANCELLED"].includes(fixture.status))
    .map((fixture) => Number(fixture.round)));
  const visibleFunctions = req.user.role === "admin" ? functions.rows : functions.rows.filter(
    (item) => String(item.user_id) === String(req.user.id) || startedRounds.has(Number(item.round)),
  );
  const participants = users.rows.filter(isCompetitionUser).map(
    (item) => ({ id: item.id, display_name: item.display_name }),
  );
  const functionPotential = {};
  for (const selection of ownFunctions) {
    if (matchFunctionCodes.has(selection.function_code)) continue;
    functionPotential[selection.function_code] = fixtures.rows
      .filter((fixture) => Number(fixture.round) === Number(selection.round))
      .filter((fixture) => predictionPotential(
        selection.function_code,
        ownPredictions.find((p) => String(p.fixture_id) === String(fixture.id)),
        fixture,
        fixtures.rows,
        selection.round,
      ))
      .map((fixture) => fixture.id);
  }
  res.json({
    user: req.user,
    canUseDela: canUseDela(req.user),
    fixtures: fixtures.rows,
    predictions: scoredPredictions,
    participants,
    users: req.user.role === "admin" ? users.rows : [],
    settings: settings.rows[0],
    functions: visibleFunctions,
    functionPotential,
    ranking: [...ranking.values()].sort((a, b) => b.total - a.total),
  });
});

app.put("/api/functions/:code", auth, async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const round = Number(req.body.round);
  const fixtureId = req.body.fixtureId ? Number(req.body.fixtureId) : null;
  if (!seasonFunctionCodes.has(code) || !Number.isInteger(round) || round < 1 || round > 38) {
    return res.status(400).json({ error: "Проверьте функцию и тур" });
  }
  if (code === "UNDERDOGS_PRIME" && round < 15) return res.status(409).json({ error: "UNDERDOGS PRIME доступна с 15-го тура" });
  const fixtures = await query("SELECT id,round,kickoff FROM fixtures WHERE round=$1 ORDER BY kickoff", [round]);
  if (!fixtures.rows.length) return res.status(404).json({ error: "В этом туре нет матчей" });
  if (new Date(fixtures.rows[0].kickoff) <= new Date()) return res.status(409).json({ error: "Тур уже начался — функцию выбрать или изменить нельзя" });
  if (matchFunctionCodes.has(code) && !fixtures.rows.some((f) => String(f.id) === String(fixtureId))) {
    return res.status(400).json({ error: "Выберите матч этого тура" });
  }
  const roundSelection = await query(
    "SELECT function_code FROM season_functions WHERE user_id=$1 AND round=$2 AND function_code<>$3 LIMIT 1",
    [req.user.id, round, code],
  );
  if (roundSelection.rows[0]) {
    return res.status(409).json({ error: "В одном туре можно использовать только одну функцию" });
  }
  const current = await query(`SELECT sf.*,MIN(f.kickoff) first_kickoff FROM season_functions sf
    JOIN fixtures f ON f.round=sf.round WHERE sf.user_id=$1 AND sf.function_code=$2
    GROUP BY sf.user_id,sf.function_code,sf.round,sf.fixture_id,sf.created_at,sf.updated_at`, [req.user.id, code]);
  if (current.rows[0] && new Date(current.rows[0].first_kickoff) <= new Date()) {
    return res.status(409).json({ error: "Эта функция уже использована и заблокирована" });
  }
  await query(`INSERT INTO season_functions(user_id,function_code,round,fixture_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(user_id,function_code) DO UPDATE SET
    round=EXCLUDED.round,fixture_id=EXCLUDED.fixture_id,updated_at=NOW()`,
  [req.user.id, code, round, matchFunctionCodes.has(code) ? fixtureId : null]);
  res.json({ ok: true });
});

app.delete("/api/functions/:code", auth, async (req, res) => {
  const code = String(req.params.code || "").toUpperCase();
  const current = await query(`SELECT sf.*,MIN(f.kickoff) first_kickoff FROM season_functions sf
    JOIN fixtures f ON f.round=sf.round WHERE sf.user_id=$1 AND sf.function_code=$2
    GROUP BY sf.user_id,sf.function_code,sf.round,sf.fixture_id,sf.created_at,sf.updated_at`, [req.user.id, code]);
  if (!current.rows[0]) return res.json({ ok: true });
  if (new Date(current.rows[0].first_kickoff) <= new Date()) return res.status(409).json({ error: "Использованную функцию удалить нельзя" });
  await query("DELETE FROM season_functions WHERE user_id=$1 AND function_code=$2", [req.user.id, code]);
  res.json({ ok: true });
});

app.get("/api/dela/state", auth, delaAccess, async (req, res) => {
  const [tasks, news, history] = await Promise.all([
    query("SELECT * FROM dela_tasks ORDER BY CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 ELSE 3 END,due_date NULLS LAST,created_at DESC"),
    query("SELECT * FROM dela_news ORDER BY published_at DESC,created_at DESC LIMIT 100"),
    query("SELECT * FROM dela_history ORDER BY created_at DESC LIMIT 100"),
  ]);
  res.json({ user: req.user, tasks: tasks.rows, news: news.rows, history: history.rows });
});

app.post("/api/dela/tasks", auth, delaAccess, async (req, res) => {
  const item = cleanTask(req.body);
  const { rows } = await query(
    `INSERT INTO dela_tasks(title,description,status,priority,due_date,created_by,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
    [item.title, item.description, item.status, item.priority, item.dueDate, req.user.display_name],
  );
  await delaAudit(req.user.display_name, "Создана задача", "task", rows[0].id, { title: item.title });
  res.status(201).json(rows[0]);
});

app.patch("/api/dela/tasks/:id", auth, delaAccess, async (req, res) => {
  const id = Number(req.params.id);
  const current = await query("SELECT * FROM dela_tasks WHERE id=$1", [id]);
  if (!current.rows[0]) return res.status(404).json({ error: "Задача не найдена" });
  const item = cleanTask({ ...current.rows[0], ...req.body, dueDate: req.body.dueDate === undefined ? current.rows[0].due_date : req.body.dueDate });
  const { rows } = await query(
    `UPDATE dela_tasks SET title=$1,description=$2,status=$3,priority=$4,due_date=$5,
     updated_by=$6,updated_at=NOW() WHERE id=$7 RETURNING *`,
    [item.title, item.description, item.status, item.priority, item.dueDate, req.user.display_name, id],
  );
  await delaAudit(req.user.display_name, "Изменена задача", "task", id, { title: item.title, status: item.status });
  res.json(rows[0]);
});

app.delete("/api/dela/tasks/:id", auth, delaAccess, async (req, res) => {
  const { rows } = await query("DELETE FROM dela_tasks WHERE id=$1 RETURNING title", [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: "Задача не найдена" });
  await delaAudit(req.user.display_name, "Удалена задача", "task", req.params.id, { title: rows[0].title });
  res.json({ ok: true });
});

app.post("/api/dela/news", auth, delaAccess, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const text = String(req.body.text || "").trim();
  const link = String(req.body.link || "").trim() || null;
  if (!title) return res.status(400).json({ error: "Укажите заголовок новости" });
  const { rows } = await query(
    `INSERT INTO dela_news(title,body,link,author) VALUES($1,$2,$3,$4) RETURNING *`,
    [title, text, link, req.user.display_name],
  );
  await delaAudit(req.user.display_name, "Добавлена новость", "news", rows[0].id, { title });
  res.status(201).json(rows[0]);
});

app.patch("/api/dela/news/:id", auth, delaAccess, async (req, res) => {
  const title = String(req.body.title || "").trim();
  const text = String(req.body.text || "").trim();
  const link = String(req.body.link || "").trim() || null;
  if (!title) return res.status(400).json({ error: "Укажите заголовок новости" });
  const { rows } = await query(
    `UPDATE dela_news SET title=$1,body=$2,link=$3 WHERE id=$4 RETURNING *`,
    [title, text, link, Number(req.params.id)],
  );
  if (!rows[0]) return res.status(404).json({ error: "Новость не найдена" });
  await delaAudit(req.user.display_name, "Изменена новость", "news", rows[0].id, { title });
  res.json(rows[0]);
});

app.delete("/api/dela/news/:id", auth, delaAccess, async (req, res) => {
  const { rows } = await query("DELETE FROM dela_news WHERE id=$1 RETURNING title", [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: "Новость не найдена" });
  await delaAudit(req.user.display_name, "Удалена новость", "news", req.params.id, { title: rows[0].title });
  res.json({ ok: true });
});

app.put("/api/predictions/:fixtureId", auth, async (req, res) => {
  const fixtureId = Number(req.params.fixtureId);
  const home = score(req.body.homeScore);
  const away = score(req.body.awayScore);
  const bonus = Boolean(req.body.bonus);
  if (!fixtureId || home === null || away === null) return res.status(400).json({ error: "Проверьте счёт" });
  const { rows } = await query("SELECT round,kickoff FROM fixtures WHERE id=$1", [fixtureId]);
  const fixture = rows[0];
  if (!fixture) return res.status(404).json({ error: "Матч не найден" });
  if (new Date(fixture.kickoff) <= new Date()) return res.status(409).json({ error: "Матч уже начался" });
  if (bonus) {
    const { rows: settings } = await query("SELECT joker_enabled FROM league_settings WHERE id=1");
    if (!settings[0]?.joker_enabled) return res.status(409).json({ error: "Матч ×2 отключён в правилах лиги" });
  }
  await transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1),$2)", [String(req.user.id), Number(fixture.round)]);
    if (bonus) {
      const existing = await client.query(
        `SELECT p.fixture_id,f.kickoff FROM predictions p
         JOIN fixtures f ON f.id=p.fixture_id
         WHERE p.user_id=$1 AND f.round=$2 AND p.bonus=TRUE AND p.fixture_id<>$3
         FOR UPDATE`,
        [req.user.id, fixture.round, fixtureId],
      );
      if (existing.rows.some((item) => new Date(item.kickoff) <= new Date())) {
        throw Object.assign(new Error("Матч ×2 в этом туре уже начался — изменить выбор нельзя"), { status: 409 });
      }
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
      [req.user.id, fixtureId, home, away, bonus],
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
  const [summary, users, predictions, logs, settings, functions] = await Promise.all([
    query(`SELECT
      (SELECT COUNT(*) FROM fixtures)::int fixtures,
      (SELECT COUNT(*) FROM fixtures WHERE home_score IS NULL OR away_score IS NULL)::int pending_results,
      (SELECT COUNT(*) FROM users WHERE role='player' AND active=TRUE AND LOWER(login)<>'test')::int active_players,
      (SELECT MAX(updated_at) FROM fixtures) last_sync`),
    query(`SELECT u.id,u.login,u.display_name,u.active,u.must_change_password,u.last_login_at,
      COUNT(p.fixture_id)::int predictions,
      COUNT(p.fixture_id) FILTER (WHERE f.kickoff>NOW())::int upcoming_predictions
      FROM users u LEFT JOIN predictions p ON p.user_id=u.id
      LEFT JOIN fixtures f ON f.id=p.fixture_id
      WHERE u.role='player' GROUP BY u.id ORDER BY u.display_name`),
    query(`SELECT p.fixture_id,p.user_id,p.home_score,p.away_score,p.bonus,p.updated_at,u.display_name
      FROM predictions p JOIN users u ON u.id=p.user_id
      WHERE u.role='player' AND u.active=TRUE AND LOWER(u.login)<>'test'
      ORDER BY p.fixture_id,u.display_name`),
    query("SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 100"),
    query("SELECT * FROM league_settings WHERE id=1"),
    query("SELECT sf.*,u.display_name FROM season_functions sf JOIN users u ON u.id=sf.user_id ORDER BY sf.round,u.display_name"),
  ]);
  res.json({
    summary: summary.rows[0],
    users: users.rows,
    predictions: predictions.rows,
    logs: logs.rows,
    settings: settings.rows[0],
    functions: functions.rows,
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

const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
const telegramAllowedIds = new Set(String(process.env.TELEGRAM_ALLOWED_IDS || "").split(",").map((x) => x.trim()).filter(Boolean));
let telegramOffset = 0;

function telegramRequest(method, body = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: "api.telegram.org",
      port: 443,
      path: `/bot${telegramToken}/${method}`,
      method: "POST",
      family: 4,
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
      timeout: 35_000,
    }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => {
        let data;
        try { data = JSON.parse(responseBody); }
        catch { return reject(new Error(`Telegram ${method}: invalid JSON (${response.statusCode})`)); }
        if (response.statusCode < 200 || response.statusCode >= 300 || !data.ok) {
          return reject(new Error(`Telegram ${method}: ${response.statusCode} ${data.description || "request failed"}`));
        }
        resolve(data);
      });
    });
    request.on("timeout", () => request.destroy(new Error(`Telegram ${method}: timeout`)));
    request.on("error", (error) => reject(new Error(`Telegram ${method}: ${error.code || error.message}`)));
    request.end(payload);
  });
}

async function telegram(method, body = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try { return await telegramRequest(method, body); }
    catch (error) {
      lastError = error;
      if (/Telegram .*: 4\d\d/.test(error.message) || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

function telegramActor(message) {
  const user = message.from || {};
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);
}

async function handleTelegram(message) {
  const chatId = message.chat?.id;
  const senderId = String(message.from?.id || "");
  if (!chatId || !telegramAllowedIds.has(senderId)) return;
  const text = String(message.text || "").trim();
  const actor = telegramActor(message);
  if (text === "/start" || text === "/help") {
    return telegram("sendMessage", { chat_id: chatId, text: "«Дела» подключены.\n\nОтправьте:\nЗадача: текст задачи\nНовость: заголовок | текст | ссылка\n\nКоманда /tasks покажет открытые задачи." });
  }
  if (text === "/tasks") {
    const { rows } = await query("SELECT id,title,status,priority,due_date FROM dela_tasks WHERE status<>'done' ORDER BY due_date NULLS LAST,created_at DESC LIMIT 15");
    const lines = rows.map((x) => `#${x.id} · ${x.title}${x.due_date ? ` · до ${new Date(x.due_date).toLocaleDateString("ru-RU")}` : ""}`);
    return telegram("sendMessage", { chat_id: chatId, text: lines.length ? lines.join("\n") : "Открытых задач нет." });
  }
  if (/^задача\s*:/i.test(text)) {
    const title = text.replace(/^задача\s*:/i, "").trim();
    if (!title) return telegram("sendMessage", { chat_id: chatId, text: "После «Задача:» укажите текст." });
    const draftId = crypto.randomUUID();
    await query(`INSERT INTO dela_bot_drafts(id,telegram_user_id,chat_id,kind,payload,actor_name) VALUES($1,$2,$3,'task',$4,$5)`, [draftId, senderId, String(chatId), JSON.stringify({ title }), actor]);
    return telegram("sendMessage", { chat_id: chatId, text: `Добавить задачу?\n\n${title}`, reply_markup: { inline_keyboard: [[{ text: "Добавить", callback_data: `confirm:${draftId}` }, { text: "Отмена", callback_data: `cancel:${draftId}` }]] } });
  }
  if (/^новость\s*:/i.test(text)) {
    const parts = text.replace(/^новость\s*:/i, "").split("|").map((x) => x.trim());
    if (!parts[0]) return telegram("sendMessage", { chat_id: chatId, text: "После «Новость:» укажите заголовок." });
    const draftId = crypto.randomUUID();
    const payload = { title: parts[0], body: parts[1] || "", link: parts[2] || null };
    await query(`INSERT INTO dela_bot_drafts(id,telegram_user_id,chat_id,kind,payload,actor_name) VALUES($1,$2,$3,'news',$4,$5)`, [draftId, senderId, String(chatId), JSON.stringify(payload), actor]);
    return telegram("sendMessage", { chat_id: chatId, text: `Добавить новость?\n\n${payload.title}${payload.body ? `\n${payload.body}` : ""}`, reply_markup: { inline_keyboard: [[{ text: "Добавить", callback_data: `confirm:${draftId}` }, { text: "Отмена", callback_data: `cancel:${draftId}` }]] } });
  }
  return telegram("sendMessage", { chat_id: chatId, text: "Не понял сообщение. Используйте «Задача: …», «Новость: …» или /tasks." });
}

async function handleTelegramCallback(callback) {
  const senderId = String(callback.from?.id || "");
  if (!telegramAllowedIds.has(senderId)) return;
  const [action, draftId] = String(callback.data || "").split(":");
  if (!draftId || !["confirm", "cancel"].includes(action)) return;
  const { rows } = await query("DELETE FROM dela_bot_drafts WHERE id=$1 AND telegram_user_id=$2 AND expires_at>NOW() RETURNING *", [draftId, senderId]);
  const draft = rows[0];
  if (!draft) return telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Черновик уже обработан или истёк" });
  if (action === "cancel") {
    await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Отменено" });
    return telegram("editMessageText", { chat_id: callback.message.chat.id, message_id: callback.message.message_id, text: "Добавление отменено." });
  }
  let created;
  if (draft.kind === "task") {
    created = await query(`INSERT INTO dela_tasks(title,created_by,updated_by) VALUES($1,$2,$2) RETURNING id,title`, [draft.payload.title, draft.actor_name]);
    await delaAudit(draft.actor_name, "Создана задача через Telegram", "task", created.rows[0].id, { title: draft.payload.title });
  } else {
    created = await query(`INSERT INTO dela_news(title,body,link,author) VALUES($1,$2,$3,$4) RETURNING id,title`, [draft.payload.title, draft.payload.body || "", draft.payload.link || null, draft.actor_name]);
    await delaAudit(draft.actor_name, "Добавлена новость через Telegram", "news", created.rows[0].id, { title: draft.payload.title });
  }
  await telegram("answerCallbackQuery", { callback_query_id: callback.id, text: "Добавлено" });
  return telegram("editMessageText", { chat_id: callback.message.chat.id, message_id: callback.message.message_id, text: `${draft.kind === "task" ? "Задача" : "Новость"} добавлена: ${created.rows[0].title}` });
}

async function pollTelegram() {
  if (!telegramToken || !telegramAllowedIds.size) return;
  try {
    const data = await telegram("getUpdates", { offset: telegramOffset, timeout: 25, allowed_updates: ["message", "callback_query"] });
    for (const update of data.result || []) {
      telegramOffset = update.update_id + 1;
      if (update.message) await handleTelegram(update.message);
      if (update.callback_query) await handleTelegramCallback(update.callback_query);
    }
  } catch (error) { console.error("Telegram polling error", error.message); }
  setTimeout(pollTelegram, 1000);
}

app.use((error, _req, res, _next) => {
  console.error(error);
  const status = error.status || (error.code === "23505" ? 409 : 500);
  res.status(status).json({ error: error.code === "23505" ? "Такая запись уже существует" : status === 500 ? "Ошибка сервера" : error.message });
});

app.get("/dela", (_req, res) => res.sendFile(path.join(root, "public", "dela", "index.html")));
app.get("/dela/*splat", (_req, res) => res.sendFile(path.join(root, "public", "dela", "index.html")));
app.get("*splat", (_req, res) => res.sendFile(path.join(root, "public", "index.html")));
app.listen(port, "0.0.0.0", () => { console.log(`APL Predictor listening on ${port}`); pollTelegram(); });
