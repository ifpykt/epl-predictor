const app = document.querySelector("#app");
let state = null;
let round = 1;
let tab = "predictions";
let adminTab = "overview";
let adminData = null;
let functionsExpanded = false;

const seasonFunctions = [
  { code: "DRAW_RAGE", name: "DRAW RAGE", scope: "Весь тур", short: "DR", rule: "За каждую угаданную ничью — +2 очка." },
  { code: "GOAL_STREAK", name: "GOAL STREAK", scope: "Весь тур", short: "GS", rule: "За каждый фактический гол в пределах вашего прогноза — +0,5 очка." },
  { code: "CLEAN_SHEET", name: "CLEAN SHEET", scope: "Весь тур", short: "CS", rule: "За каждый угаданный ноль у команды — +2; при 0:0 можно получить +4." },
  { code: "GAME_TOTAL", name: "GAME TOTAL", scope: "Один матч", short: "GT", match: true, rule: "Фактический тотал матча, если условие точности выполнено." },
  { code: "ALL_IN", name: "ALL IN", scope: "Один матч", short: "AI", match: true, rule: "Точный счёт удваивает базовые очки тура; ошибка — минус 6." },
  { code: "AWAY_VICTORY", name: "AWAY VICTORY", scope: "Весь тур", short: "AV", rule: "За каждую угаданную победу гостей — +2 очка." },
  { code: "UNDERDOGS_PRIME", name: "UNDERDOGS PRIME", scope: "Весь тур · с 15-го", short: "UP", minRound: 15, rule: "Победа команды ниже в таблице — +2; угаданная ничья — +1." },
  { code: "BTTS", name: "ОЗ", scope: "Весь тур", short: "ОЗ", rule: "Обе забьют в прогнозе и результате — +1,5 очка." },
];

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Ошибка");
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function availableRounds() {
  return [...new Set((state?.fixtures || []).map((fixture) => Number(fixture.round)))]
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
}

function automaticRound() {
  const fixtures = (state?.fixtures || []).filter((fixture) =>
    !["POSTPONED", "CANCELLED"].includes(fixture.status)
    && Number.isFinite(new Date(fixture.kickoff).getTime()));
  const upcoming = fixtures
    .filter((fixture) => new Date(fixture.kickoff).getTime() > Date.now())
    .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff))[0];
  if (upcoming) return Number(upcoming.round);
  const latest = fixtures.sort((a, b) => new Date(b.kickoff) - new Date(a.kickoff))[0];
  return Number(latest?.round || availableRounds().at(-1) || 1);
}

function roundControls(rounds = availableRounds()) {
  const index = rounds.indexOf(round);
  const current = automaticRound();
  return `<div class="round-controls">
    <button type="button" class="round-arrow" data-round-step="-1" ${index <= 0 ? "disabled" : ""} aria-label="Предыдущий тур">←</button>
    <select class="round-select" id="round">${rounds.map((item) => `<option value="${item}" ${item === round ? "selected" : ""}>Тур ${item}</option>`).join("")}</select>
    <button type="button" class="round-arrow" data-round-step="1" ${index < 0 || index >= rounds.length - 1 ? "disabled" : ""} aria-label="Следующий тур">→</button>
    <button type="button" class="current-round-button" data-current-round ${round === current ? "disabled" : ""}>Текущий тур · ${current}</button>
  </div>`;
}

function brandMark() {
  return `<svg class="brand-mark" viewBox="0 0 64 72" aria-hidden="true">
    <path d="M32 2 58 12v20c0 17.8-10.7 29.5-26 38C16.7 61.5 6 49.8 6 32V12L32 2Z" fill="#0b3328"/>
    <path d="M32 7.5 52.5 16v16.2c0 14.1-7.9 24.3-20.5 31.8C19.4 56.5 11.5 46.3 11.5 32.2V16L32 7.5Z" fill="#dff74e"/>
    <path d="M15.5 18.7 32 11.9l16.5 6.8v13.5c0 11.6-6.2 20.2-16.5 26.8-10.3-6.6-16.5-15.2-16.5-26.8V18.7Z" fill="#12633f"/>
    <circle cx="32" cy="28" r="11.2" fill="#fff"/>
    <path d="m32 21.3 4.2 3-1.6 4.9h-5.2l-1.6-4.9 4.2-3Zm-9.7 3.7 5.5-.7m-7 6.2 4.7 3.2m2.2 5.2 1.7-5.1m6.9 5.1-1.7-5.1m8.6-3.3-4.7 3.2m3.2-8.7-5.5-.7" fill="none" stroke="#0b3328" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M19.5 44.5h25v9h-25z" rx="2" fill="#f6c453"/>
    <text x="32" y="51.1" text-anchor="middle" font-size="6.8" font-weight="900" font-family="Arial, sans-serif" fill="#0b3328">1 · X · 2</text>
  </svg>`;
}

function loginView(error = "") {
  app.innerHTML = `<main class="login">
    <section class="login-visual">
      <div class="login-brand">${brandMark()}<span>Футбольная лига прогнозов</span></div>
      <span class="kicker">Сезон 2026/27 · Премьер-лига</span>
      <h1>Лига лысых<br>шарлатанов</h1>
      <p>Здесь футбольная интуиция встречается с холодным расчётом. Ставьте точный счёт, выбирайте сезонные функции и забирайте первое место.</p>
      <div class="odds-strip" aria-hidden="true"><span>1</span><i></i><span>X</span><i></i><span>2</span><b>MAKE YOUR PICK</b></div>
    </section>
    <section class="login-form"><form class="card" id="login"><h2>Вход в лигу</h2><p class="sub">Введите логин и пароль, выданные администратором.</p>
      <label class="field"><span>Логин</span><input name="login" autocomplete="username" required></label>
      <label class="field"><span>Пароль</span><input name="password" type="password" autocomplete="current-password" required></label>
      <div class="error">${esc(error)}</div><button class="primary full">Войти</button></form></section></main>`;
  document.querySelector("#login").onsubmit = async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    try { await api("/api/login", { method: "POST", body: JSON.stringify(values) }); await load(); }
    catch (e) { loginView(e.message); }
  };
}

async function load() {
  try {
    state = await api("/api/state");
    round = automaticRound();
    render();
  } catch { loginView(); }
}

function predictionFor(fixture) {
  return state.predictions.find((p) => String(p.fixture_id) === String(fixture.id) && String(p.user_id) === String(state.user.id));
}

function functionSelection(code) {
  return (state.functions || []).find((item) => item.function_code === code && String(item.user_id) === String(state.user.id));
}

function fixtureLabel(id) {
  const fixture = state.fixtures.find((item) => String(item.id) === String(id));
  return fixture ? `${fixture.home_name} — ${fixture.away_name}` : "";
}

function render() {
  const isAdmin = state.user.role === "admin";
  const participantPasswordForm = state.user.must_change_password && !isAdmin ? passwordView() : "";
  app.innerHTML = `<header class="top"><div class="brand">${brandMark()}<span class="brand-copy"><strong>Лига лысых шарлатанов</strong><small>Футбольные прогнозы</small></span></div>
    <div class="account">${state.canUseDela ? `<a class="link" href="/dela">Дела</a>` : ""}<small>${esc(state.user.display_name)} · ${isAdmin ? "Администратор" : "Участник"}</small><button class="link" id="logout">Выйти</button></div></header>
    <section class="hero"><div class="hero-copy"><span class="kicker">Премьер-лига · ${esc(state.settings?.season_name || "сезон 2026/27")}</span><div class="matchday"><span class="round-badge"><small>Тур</small><b>${round}</b></span><div><h1>Матчдэй ${round}</h1></div></div></div>
      <nav class="tabs"><button data-tab="predictions" class="${tab === "predictions" ? "active" : ""}">Прогнозы</button><button data-tab="table" class="${tab === "table" ? "active" : ""}">Таблица</button>${isAdmin ? `<button data-tab="admin" class="${tab === "admin" ? "active" : ""}">Управление</button>` : ""}</nav></section>
    <main class="wrap">${state.user.must_change_password ? `<div class="notice">При первом входе смените временный пароль ${isAdmin ? "в разделе «Управление»" : "в форме ниже"}.</div>` : ""}${participantPasswordForm}${content()}</main>`;
  document.querySelector("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); loginView(); };
  document.querySelectorAll("[data-tab]").forEach((button) => button.onclick = () => { tab = button.dataset.tab; render(); });
  bind();
}

function content() {
  if (tab === "table") return tableView();
  if (tab === "admin" && state.user.role === "admin") return adminView();
  const rounds = availableRounds();
  const fixtures = state.fixtures.filter((f) => Number(f.round) === round);
  return `<div class="toolbar"><h2>Ваш прогноз</h2>${roundControls(rounds)}</div>
    ${functionsView(fixtures)}
    <div class="grid"><section class="panel">${fixtures.length ? fixtures.map(matchView).join("") : `<div class="empty">Календарь ещё не загружен. Администратору нужно нажать «Получить календарь».</div>`}</section>
    <aside class="panel side"><h3>Лидеры сезона</h3>${ranking()}</aside></div>`;
}

function functionsView(fixtures) {
  const firstKickoff = fixtures[0] ? Math.min(...fixtures.map((item) => new Date(item.kickoff).getTime())) : 0;
  const roundLocked = !firstKickoff || firstKickoff <= Date.now();
  const used = seasonFunctions.filter((item) => functionSelection(item.code)).length;
  const selectedInRound = (state.functions || []).find(
    (item) => String(item.user_id) === String(state.user.id) && Number(item.round) === round,
  );
  return `<details class="panel functions-panel" ${functionsExpanded ? "open" : ""}>
    <summary class="functions-head"><div><p class="eyebrow">8 функций на сезон</p><h3>Сезонные функции</h3><p class="sub">Каждую можно применить только один раз за сезон, а в одном туре — только одну функцию. Выбор блокируется с началом первого матча тура.</p></div><b>${used} / 8 · ${functionsExpanded ? "Свернуть" : "Развернуть"}</b></summary>
    <div class="function-grid">${seasonFunctions.map((item) => {
      const selected = functionSelection(item.code);
      const selectedHere = Number(selected?.round) === round;
      const anotherSelectedHere = Boolean(selectedInRound) && selectedInRound.function_code !== item.code;
      const unavailable = roundLocked || round < Number(item.minRound || 1) || (!selectedHere && anotherSelectedHere);
      const selectedFixture = selected?.fixture_id ? fixtureLabel(selected.fixture_id) : "";
      const selectedInRoundName = seasonFunctions.find((entry) => entry.code === selectedInRound?.function_code)?.name;
      const actionLabel = selectedHere ? "Отменить выбор"
        : anotherSelectedHere ? `В туре уже выбрана ${selectedInRoundName}`
          : round < Number(item.minRound || 1) ? "Доступно с 15-го тура"
            : roundLocked ? "Тур уже начался" : `Применить в туре ${round}`;
      return `<article class="function-card ${selectedHere ? "active" : ""} ${selected && !selectedHere ? "used" : ""}" data-function-card="${item.code}">
        <div class="function-title"><span>${item.short}</span><div><b>${item.name}</b><small>${item.scope}</small></div></div>
        <p>${item.rule}</p>
        ${selected ? `<div class="function-used">Выбрано: тур ${selected.round}${selectedFixture ? ` · ${esc(selectedFixture)}` : ""}</div>` : ""}
        ${item.match && (!selected || selectedHere) ? `<select class="function-match" ${unavailable ? "disabled" : ""}><option value="">Выберите матч</option>${fixtures.map((fixture) => `<option value="${fixture.id}" ${String(selected?.fixture_id) === String(fixture.id) ? "selected" : ""}>${esc(fixture.home_name)} — ${esc(fixture.away_name)}</option>`).join("")}</select>` : ""}
        ${!selected || selectedHere ? `<button class="${selectedHere ? "function-cancel" : "function-activate"}" data-function="${item.code}" ${unavailable ? "disabled" : ""}>${actionLabel}</button>` : `<span class="function-locked">Используется один раз за сезон</span>`}
      </article>`;
    }).join("")}</div>
    <details class="function-rules"><summary>Как считаются функции и базовые очки</summary><p><b>База:</b> точный счёт — 3, разница — 2, исход — 1. В каждом туре можно выбрать один матч ×2 и удвоить базовые очки за него. ×2 не относится к восьми сезонным функциям.</p><p><b>GAME TOTAL:</b> начисляется весь фактический тотал, если прогноз по голам каждой команды отклоняется от результата не более чем на два гола.</p><p><b>ALL IN:</b> при точном счёте выбранного матча базовые очки всего тура удваиваются; иначе начисляется −6. Другие функции не удваиваются.</p><p><b>UNDERDOGS PRIME:</b> положение команд фиксируется по таблице на начало тура.</p></details>
  </details>`;
}

function matchView(fixture) {
  const p = predictionFor(fixture);
  const locked = new Date(fixture.kickoff) <= new Date();
  const roundBonus = state.predictions.find((item) => {
    if (!item.bonus || String(item.user_id) !== String(state.user.id)) return false;
    const selectedFixture = state.fixtures.find((entry) => String(entry.id) === String(item.fixture_id));
    return Number(selectedFixture?.round) === Number(fixture.round);
  });
  const roundBonusFixture = state.fixtures.find((item) => String(item.id) === String(roundBonus?.fixture_id));
  const roundBonusLocked = roundBonusFixture && new Date(roundBonusFixture.kickoff) <= new Date();
  const bonusDisabled = locked || state.settings?.joker_enabled === false || (roundBonusLocked && !p?.bonus);
  const bonusTitle = state.settings?.joker_enabled === false ? "Матч ×2 отключён правилами"
    : roundBonusLocked && !p?.bonus ? "Матч ×2 в этом туре уже начался"
      : p?.bonus ? "Отменить выбор ×2" : "Удвоить базовые очки за этот матч";
  const potential = seasonFunctions.filter((item) => {
    const selection = functionSelection(item.code);
    if (!selection || Number(selection.round) !== Number(fixture.round) || !p) return false;
    if (item.match) return String(selection.fixture_id) === String(fixture.id);
    return (state.functionPotential?.[item.code] || []).some((id) => String(id) === String(fixture.id));
  });
  return `<article class="match ${locked ? "locked" : ""}" data-fixture="${fixture.id}">
    <div class="team home"><span>${esc(fixture.home_name)}</span><img class="crest" src="${esc(fixture.home_crest)}" alt=""></div>
    <div class="score"><div><input data-side="home" type="number" min="0" max="30" value="${p?.home_score ?? ""}" ${locked ? "disabled" : ""}><small>${new Date(fixture.kickoff).toLocaleString("ru-RU",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}</small></div><b>:</b><input data-side="away" type="number" min="0" max="30" value="${p?.away_score ?? ""}" ${locked ? "disabled" : ""}></div>
    <div class="team"><img class="crest" src="${esc(fixture.away_crest)}" alt=""><span>${esc(fixture.away_name)}</span></div>
    <div class="match-actions"><button class="bonus ${p?.bonus ? "on" : ""}" ${bonusDisabled ? "disabled" : ""} title="${esc(bonusTitle)}">×2</button><div class="match-functions">${potential.map((item) => `<span title="${esc(item.rule)}">${item.short}</span>`).join("")}</div></div></article>`;
}

function formatPoints(value) {
  return Number(value || 0).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

function ranking() {
  if (!state.ranking.length) return `<p class="sub">Очки появятся после первых результатов.</p>`;
  const roundHasResults = state.fixtures.some((fixture) =>
    Number(fixture.round) === round && fixture.home_score !== null && fixture.away_score !== null);
  return `<div class="ranking-head"><span>Участник</span><span>Тур ${round}</span><span>Всего</span></div>${state.ranking.map((item, index) => {
    const roundPoints = item.rounds?.[String(round)] || { base: 0, bonus: 0, total: 0 };
    const breakdown = roundHasResults
      ? `<small>База ${formatPoints(roundPoints.base)}${roundPoints.bonus ? ` · функции ${roundPoints.bonus > 0 ? "+" : ""}${formatPoints(roundPoints.bonus)}` : ""}</small>`
      : "";
    return `<div class="rank"><span>${index + 1}. ${esc(item.name)}${breakdown}</span><b class="round-total">${formatPoints(roundPoints.total)}</b><b>${formatPoints(item.total)}</b></div>`;
  }).join("")}`;
}

function tableView() {
  const rounds = availableRounds();
  const fixtures = state.fixtures.filter((fixture) => Number(fixture.round) === round);
  const participants = state.participants || [];
  const participantIds = new Set(participants.map((participant) => String(participant.id)));
  return `<div class="toolbar"><div><h2>Общий зачёт</h2><p class="sub">Прогнозы участников открываются после начала каждого матча.</p></div>
      ${roundControls(rounds)}</div>
    <section class="panel side table-ranking">${ranking()}</section>
    <div class="toolbar compact public-predictions-head"><div><h3>Прогнозы участников · тур ${round}</h3><p class="sub">До стартового свистка чужие прогнозы скрыты.</p></div></div>
    <section class="prediction-admin-list public-predictions">${fixtures.length ? fixtures.map((fixture) => {
      const started = new Date(fixture.kickoff) <= new Date() && !["POSTPONED", "CANCELLED"].includes(fixture.status);
      const fixturePredictions = started ? state.predictions.filter(
        (prediction) => String(prediction.fixture_id) === String(fixture.id)
          && participantIds.has(String(prediction.user_id)),
      ) : [];
      const byUser = new Map(fixturePredictions.map((prediction) => [String(prediction.user_id), prediction]));
      const result = fixture.home_score === null || fixture.away_score === null
        ? "" : `<b>Результат ${fixture.home_score}:${fixture.away_score}</b>`;
      return `<article class="panel prediction-admin-card ${started ? "" : "predictions-locked"}">
        <header class="prediction-admin-head"><div><small>Тур ${fixture.round} · ${new Date(fixture.kickoff).toLocaleString("ru-RU",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}</small><h4>${esc(fixture.home_name)} — ${esc(fixture.away_name)}</h4></div>
          ${started ? `<span class="prediction-count ${fixturePredictions.length === participants.length && participants.length ? "complete" : ""}">${fixturePredictions.length} из ${participants.length}</span>` : `<span class="prediction-count locked-count">Скрыто</span>`}</header>
        ${started ? `<div class="prediction-admin-grid">${participants.length ? participants.map((participant) => {
          const prediction = byUser.get(String(participant.id));
          const userFunctions = (state.functions || []).filter((item) =>
            String(item.user_id) === String(participant.id)
            && Number(item.round) === Number(fixture.round)
            && (!item.fixture_id || String(item.fixture_id) === String(fixture.id)));
          const tags = [
            prediction?.bonus ? "×2" : "",
            ...userFunctions.map((item) => seasonFunctions.find((entry) => entry.code === item.function_code)?.short || item.function_code),
          ].filter(Boolean);
          const pointsLabel = prediction?.total_points === null || prediction?.total_points === undefined
            ? "Очки после результата"
            : `${prediction.total_points > 0 ? "+" : ""}${formatPoints(prediction.total_points)} очк.`;
          const breakdownLabel = prediction?.total_points === null || prediction?.total_points === undefined
            ? "" : `База ${formatPoints(prediction.base_points)} · функции ${prediction.function_points > 0 ? "+" : ""}${formatPoints(prediction.function_points)}`;
          return `<div class="prediction-chip ${prediction ? "" : "missing"}"><span>${esc(participant.display_name)}${tags.length ? `<small class="admin-function-tags">${tags.map(esc).join(" · ")}</small>` : ""}</span>${prediction ? `<div class="prediction-score"><b>${prediction.home_score}:${prediction.away_score}</b><small class="prediction-earned">${pointsLabel}${breakdownLabel ? `<em>${breakdownLabel}</em>` : ""}</small></div>` : `<small>Нет прогноза</small>`}</div>`;
        }).join("") : `<div class="empty">Участников пока нет.</div>`}</div>`
          : `<div class="predictions-hidden">Прогнозы откроются после начала матча</div>`}
        <footer class="prediction-admin-status"><span class="${started ? "closed" : "open"}">${started ? "Прогнозы открыты" : "Приём продолжается"}</span>${result}</footer>
      </article>`;
    }).join("") : `<section class="panel empty">В этом туре нет матчей.</section>`}</section>`;
}

function passwordView() {
  return `<section class="panel side" style="margin-bottom:20px"><h3>Смена временного пароля</h3><form id="password"><label class="field"><span>Новый пароль</span><input name="password" type="password" minlength="8" autocomplete="new-password" required></label><button class="primary">Сохранить</button></form></section>`;
}

function adminView() {
  if (!adminData) {
    api("/api/admin/dashboard").then((data) => { adminData = data; render(); }).catch((e) => alert(e.message));
    return `<section class="panel empty">Загружаем панель администратора…</section>`;
  }
  const labels = { overview: "Обзор", predictions: "Прогнозы", fixtures: "Матчи", users: "Участники", rules: "Правила", log: "Журнал" };
  return `<div class="toolbar"><div><p class="eyebrow">Панель администратора</p><h2>Управление лигой</h2></div><button class="primary" id="sync">Обновить матчи</button></div>
    <nav class="admin-tabs">${Object.entries(labels).map(([key,label]) => `<button data-admin-tab="${key}" class="${adminTab === key ? "active" : ""}">${label}</button>`).join("")}</nav>
    ${adminContent()}`;
}

function adminContent() {
  if (adminTab === "predictions") return predictionsAdminView();
  if (adminTab === "fixtures") return fixturesAdminView();
  if (adminTab === "users") return usersAdminView();
  if (adminTab === "rules") return rulesAdminView();
  if (adminTab === "log") return logAdminView();
  const next = state.fixtures.find((f) => new Date(f.kickoff) > new Date());
  const inRound = state.fixtures.filter((f) => Number(f.round) === Number(next?.round));
  const competitionUsers = adminData.users.filter((user) => user.active && String(user.login).toLowerCase() !== "test");
  const submitted = competitionUsers.filter((user) => Number(user.upcoming_predictions) > 0);
  const missing = competitionUsers.filter((user) => user.active && !Number(user.upcoming_predictions));
  return `<div class="stat-grid">
      <article class="stat"><small>Матчей в календаре</small><b>${adminData.summary.fixtures}</b><span>${adminData.summary.pending_results} без результата</span></article>
      <article class="stat"><small>Активных участников</small><b>${adminData.summary.active_players}</b><span>${submitted.length} уже ставили на будущие матчи</span></article>
      <article class="stat"><small>Ближайший матч</small><b class="stat-date">${next ? new Date(next.kickoff).toLocaleString("ru-RU",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "—"}</b><span>${next ? `${esc(next.home_name)} — ${esc(next.away_name)}` : "Календарь завершён"}</span></article>
      <article class="stat"><small>Последняя синхронизация</small><b class="stat-date">${adminData.summary.last_sync ? new Date(adminData.summary.last_sync).toLocaleString("ru-RU") : "—"}</b><span>Источник: football-data.org</span></article>
    </div>
    <div class="admin-grid">
      <section class="panel side"><h3>Готовность к туру ${next?.round || "—"}</h3><div class="progress"><i style="width:${adminData.summary.active_players ? Math.round(submitted.length/adminData.summary.active_players*100) : 0}%"></i></div><p><b>${submitted.length} из ${adminData.summary.active_players}</b> участников заполнили хотя бы один прогноз на будущие матчи.</p>${missing.length ? `<p class="warning-text">Нет прогнозов: ${missing.map((u)=>esc(u.display_name)).join(", ")}</p>` : `<p class="success-text">Все участники начали заполнять прогнозы.</p>`}</section>
      <section class="panel side"><h3>Состояние системы</h3><div class="health-row"><span>База и приложение</span><b>Работают</b></div><div class="health-row"><span>Матчей в ближайшем туре</span><b>${inRound.length}</b></div><div class="health-row"><span>Последнее действие</span><b>${esc(adminData.logs[0]?.action || "—")}</b></div></section>
    </div>`;
}

function predictionsAdminView() {
  const rounds = availableRounds();
  const fixtures = state.fixtures.filter((f) => Number(f.round) === round);
  const users = adminData.users.filter((user) => user.active && String(user.login).toLowerCase() !== "test");
  const userIds = new Set(users.map((user) => String(user.id)));
  const predictions = (adminData.predictions || []).filter((prediction) => userIds.has(String(prediction.user_id)));
  const functions = (adminData.functions || []).filter((item) => userIds.has(String(item.user_id)));
  return `<div class="toolbar compact"><div><h3>Прогнозы участников</h3><p class="sub admin-predictions-note">Доступны вам как независимому администратору. Для участников чужие прогнозы до начала матча остаются скрыты.</p></div>
      ${roundControls(rounds)}</div>
    <section class="prediction-admin-list">${fixtures.length ? fixtures.map((fixture) => {
      const fixturePredictions = predictions.filter((prediction) => String(prediction.fixture_id) === String(fixture.id));
      const byUser = new Map(fixturePredictions.map((prediction) => [String(prediction.user_id), prediction]));
      const started = new Date(fixture.kickoff) <= new Date();
      return `<article class="panel prediction-admin-card">
        <header class="prediction-admin-head"><div><small>Тур ${fixture.round} · ${new Date(fixture.kickoff).toLocaleString("ru-RU",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}</small><h4>${esc(fixture.home_name)} — ${esc(fixture.away_name)}</h4></div>
          <span class="prediction-count ${fixturePredictions.length === users.length && users.length ? "complete" : ""}">${fixturePredictions.length} из ${users.length}</span></header>
        <div class="prediction-admin-grid">${users.length ? users.map((user) => {
          const prediction = byUser.get(String(user.id));
          const userFunctions = functions.filter((item) => String(item.user_id) === String(user.id) && Number(item.round) === Number(fixture.round)
            && (!item.fixture_id || String(item.fixture_id) === String(fixture.id)));
          return `<div class="prediction-chip ${prediction ? "" : "missing"}"><span>${esc(user.display_name)}${userFunctions.length ? `<small class="admin-function-tags">${userFunctions.map((item) => seasonFunctions.find((x) => x.code === item.function_code)?.short || item.function_code).join(" · ")}</small>` : ""}</span>${prediction ? `<b>${prediction.home_score}:${prediction.away_score}</b>` : `<small>Нет прогноза</small>`}</div>`;
        }).join("") : `<div class="empty">Активных участников пока нет.</div>`}</div>
        <footer class="prediction-admin-status"><span class="${started ? "closed" : "open"}">${started ? "Матч начался" : "Приём открыт"}</span>${fixture.home_score === null || fixture.away_score === null ? "" : `<b>Результат ${fixture.home_score}:${fixture.away_score}</b>`}</footer>
      </article>`;
    }).join("") : `<section class="panel empty">В этом туре нет матчей.</section>`}</section>`;
}

const fixtureStatuses = {
  SCHEDULED: "Запланирован",
  TIMED: "Время подтверждено",
  IN_PLAY: "Идёт",
  FINISHED: "Завершён",
  POSTPONED: "Перенесён",
  CANCELLED: "Отменён"
};

function fixturesAdminView() {
  const rounds = availableRounds();
  const fixtures = state.fixtures.filter((f) => Number(f.round) === round);
  return `<div class="toolbar compact"><div><h3>Матчи сезона</h3><p class="sub fixture-help">Изменяйте данные только при переносе, отмене или ручном исправлении результата.</p></div>${roundControls(rounds)}</div>
    <section class="admin-list fixture-list">${fixtures.map((f)=>`<form class="panel fixture-row" data-fixture-form="${f.id}">
      <div class="fixture-name"><span class="fixture-status status-${esc(f.status.toLowerCase())}">${esc(fixtureStatuses[f.status] || f.status)}</span><b>${esc(f.home_name)} — ${esc(f.away_name)}</b></div>
      <label class="fixture-field"><span>Дата и время</span><input name="kickoff" type="datetime-local" value="${new Date(new Date(f.kickoff).getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16)}"></label>
      <label class="fixture-field"><span>Статус</span><select name="status">${Object.entries(fixtureStatuses).map(([value,label])=>`<option value="${value}" ${value===f.status?"selected":""}>${label}</option>`).join("")}</select></label>
      <div class="fixture-field fixture-result" ${f.status === "FINISHED" ? "" : "hidden"}><span>Итоговый счёт</span><div class="result-input"><label><span>Хозяева</span><input name="homeScore" type="number" min="0" max="30" value="${f.home_score ?? ""}" placeholder="0"></label><b>:</b><label><span>Гости</span><input name="awayScore" type="number" min="0" max="30" value="${f.away_score ?? ""}" placeholder="0"></label></div></div>
      <label class="fixture-field fixture-reason"><span>Причина изменения</span><input name="reason" placeholder="Например: матч перенесён на новую дату" minlength="5" required></label>
      <button class="secondary fixture-save">Сохранить изменения</button>
    </form>`).join("")}</section>`;
}

function usersAdminView() {
  return `<section class="panel"><form class="admin-form" id="new-user"><input name="displayName" placeholder="Имя участника" required><input name="login" placeholder="Логин латиницей" required><input name="temporaryPassword" type="password" minlength="8" placeholder="Временный пароль (8+)" required><button class="primary">Создать</button></form>
    <div class="users">${adminData.users.map((u)=>`<div class="user-row detailed"><span><b>${esc(u.display_name)}</b><small>@${esc(u.login)} · ${u.predictions} прогнозов · ${u.last_login_at ? `был ${new Date(u.last_login_at).toLocaleDateString("ru-RU")}` : "ещё не входил"}</small></span><span class="user-actions">${u.must_change_password ? `<em>Временный пароль</em>` : ""}<button class="link reset-password" data-id="${u.id}">Сбросить пароль</button><button class="link toggle-user" data-id="${u.id}" data-active="${u.active}">${u.active ? "Архивировать" : "Активировать"}</button></span></div>`).join("")}</div></section>
    <section class="panel side password-card"><h3>Смена моего пароля</h3><form id="password"><label class="field"><span>Новый пароль</span><input name="password" type="password" minlength="8" required></label><button class="primary">Сохранить</button></form></section>`;
}

function rulesAdminView() {
  const s=adminData.settings;
  return `<form class="panel settings-form" id="rules-form"><div><p class="eyebrow">Сезон и начисление</p><h3>Правила лиги</h3><p class="sub">Изменение очков после старта требует отдельного подтверждения и фиксируется в журнале.</p></div>
    <label class="field"><span>Название сезона</span><input name="seasonName" value="${esc(s.season_name)}" required></label>
    <div class="points-grid"><label class="field"><span>Точный счёт</span><input name="exactPoints" type="number" min="0" max="20" value="${s.exact_points}"></label><label class="field"><span>Разница мячей</span><input name="differencePoints" type="number" min="0" max="20" value="${s.difference_points}"></label><label class="field"><span>Исход</span><input name="outcomePoints" type="number" min="0" max="20" value="${s.outcome_points}"></label></div>
    <div class="rules-note"><b>Сезонные функции включены</b><span>Каждый участник может применить каждую из восьми функций один раз за сезон. Выбор закрывается с началом тура.</span></div>
    <label class="field"><span>Текст правил для участников</span><textarea name="rulesText" rows="6">${esc(s.rules_text)}</textarea></label>
    <label class="check danger-check"><input name="confirmRecalculate" type="checkbox"><span>Подтверждаю пересчёт сезона, если матчи уже начались</span></label><button class="primary">Сохранить правила</button></form>`;
}

function logAdminView() {
  return `<section class="panel audit-list">${adminData.logs.length ? adminData.logs.map((x)=>`<article><time>${new Date(x.created_at).toLocaleString("ru-RU")}</time><div><b>${esc(x.action)}</b><span>${esc(x.actor_name)}${x.details?.reason ? ` · ${esc(x.details.reason)}` : ""}</span></div></article>`).join("") : `<div class="empty">Журнал пока пуст.</div>`}</section>`;
}

function bind() {
  const roundSelect = document.querySelector("#round");
  if (roundSelect) roundSelect.onchange = () => {
    const selectedRound = Number(roundSelect.value);
    if (!Number.isInteger(selectedRound)) return;
    round = selectedRound;
    render();
  };
  document.querySelectorAll("[data-round-step]").forEach((button) => button.onclick = () => {
    const rounds = availableRounds();
    const index = rounds.indexOf(round);
    const next = rounds[index + Number(button.dataset.roundStep)];
    if (!Number.isInteger(next)) return;
    round = next;
    render();
  });
  const currentRoundButton = document.querySelector("[data-current-round]");
  if (currentRoundButton) currentRoundButton.onclick = () => {
    round = automaticRound();
    render();
  };
  const functionsPanel = document.querySelector(".functions-panel");
  if (functionsPanel) functionsPanel.ontoggle = () => { functionsExpanded = functionsPanel.open; };
  document.querySelectorAll(".match").forEach((row) => {
    const save = async () => {
      const homeScore = row.querySelector('[data-side="home"]').value;
      const awayScore = row.querySelector('[data-side="away"]').value;
      if (homeScore === "" || awayScore === "") return false;
      await api(`/api/predictions/${row.dataset.fixture}`, {
        method: "PUT",
        body: JSON.stringify({ homeScore, awayScore, bonus: row.querySelector(".bonus").classList.contains("on") }),
      });
      state = await api("/api/state");
      render();
      return true;
    };
    row.querySelectorAll("input").forEach((input) => input.onchange = () => save().catch((e) => alert(e.message)));
    row.querySelector(".bonus").onclick = async (event) => {
      const homeScore = row.querySelector('[data-side="home"]').value;
      const awayScore = row.querySelector('[data-side="away"]').value;
      if (homeScore === "" || awayScore === "") return alert("Сначала укажите счёт");
      const button = event.currentTarget;
      const enabling = !button.classList.contains("on");
      if (enabling) document.querySelectorAll(".bonus").forEach((item) => item.classList.remove("on"));
      button.classList.toggle("on", enabling);
      try { await save(); }
      catch (error) {
        state = await api("/api/state");
        render();
        alert(error.message);
      }
    };
  });
  document.querySelectorAll(".function-activate").forEach((button) => button.onclick = async () => {
    const card = button.closest("[data-function-card]");
    const fixtureId = card.querySelector(".function-match")?.value || null;
    if (card.querySelector(".function-match") && !fixtureId) return alert("Сначала выберите матч");
    try {
      await api(`/api/functions/${button.dataset.function}`, { method: "PUT", body: JSON.stringify({ round, fixtureId }) });
      state = await api("/api/state"); render();
    } catch (e) { alert(e.message); }
  });
  document.querySelectorAll(".function-cancel").forEach((button) => button.onclick = async () => {
    if (!confirm("Отменить выбор функции до начала тура?")) return;
    try {
      await api(`/api/functions/${button.dataset.function}`, { method: "DELETE" });
      state = await api("/api/state"); render();
    } catch (e) { alert(e.message); }
  });
  const sync = document.querySelector("#sync");
  if (sync) sync.onclick = async () => { sync.disabled = true; try { const r = await api("/api/admin/sync", { method: "POST" }); alert(`Обновлено матчей: ${r.updated}`); adminData=null; await load(); } catch (e) { alert(e.message); } finally { sync.disabled = false; } };
  document.querySelectorAll("[data-admin-tab]").forEach((button)=>button.onclick=()=>{adminTab=button.dataset.adminTab;render();});
  const newUser = document.querySelector("#new-user");
  if (newUser) newUser.onsubmit = async (event) => { event.preventDefault(); try { await api("/api/admin/users", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(newUser))) }); adminData=null; tab="admin";adminTab="users";await load(); } catch (e) { alert(e.message); } };
  document.querySelectorAll(".toggle-user").forEach((button) => button.onclick = async () => { await api(`/api/admin/users/${button.dataset.id}`, { method: "PATCH", body: JSON.stringify({ active: button.dataset.active !== "true" }) }); adminData=null;tab="admin";adminTab="users";await load(); });
  document.querySelectorAll(".reset-password").forEach((button)=>button.onclick=async()=>{const temporaryPassword=prompt("Новый временный пароль (минимум 8 символов)");if(!temporaryPassword)return;try{await api(`/api/admin/users/${button.dataset.id}/reset-password`,{method:"POST",body:JSON.stringify({temporaryPassword})});alert("Временный пароль установлен, активные сеансы завершены");adminData=null;tab="admin";adminTab="users";await load();}catch(e){alert(e.message);}});
  document.querySelectorAll("[data-fixture-form]").forEach((form) => {
    const status = form.querySelector('[name="status"]');
    const result = form.querySelector(".fixture-result");
    status.onchange = () => { result.hidden = status.value !== "FINISHED"; };
    form.onsubmit = async (event) => {
      event.preventDefault();
      try {
        await api(`/api/admin/fixtures/${form.dataset.fixtureForm}`, { method: "PATCH", body: JSON.stringify(Object.fromEntries(new FormData(form))) });
        alert("Матч обновлён");
        adminData = null; tab = "admin"; adminTab = "fixtures"; await load();
      } catch (e) { alert(e.message); }
    };
  });
  const rules=document.querySelector("#rules-form");
  if(rules)rules.onsubmit=async(event)=>{event.preventDefault();const values=Object.fromEntries(new FormData(rules));values.jokerEnabled=false;values.confirmRecalculate=rules.confirmRecalculate.checked;try{await api("/api/admin/settings",{method:"PATCH",body:JSON.stringify(values)});alert("Правила сохранены");adminData=null;tab="admin";adminTab="rules";await load();}catch(e){alert(e.message);}};
  const password = document.querySelector("#password");
  if (password) password.onsubmit = async (event) => { event.preventDefault(); try { await api("/api/change-password", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(password))) }); alert("Пароль изменён"); await load(); } catch (e) { alert(e.message); } };
}

load();
