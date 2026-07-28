const app = document.querySelector("#app");
let state = null;
let round = 1;
let tab = "predictions";

async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Ошибка");
  return data;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function loginView(error = "") {
  app.innerHTML = `<main class="login">
    <section class="login-visual"><span class="kicker">Сезон 2026/27</span><h1>АПЛ<br>Прогноз</h1><p>Закрытая лига прогнозов для вашей футбольной компании.</p></section>
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
    const upcoming = state.fixtures.find((f) => new Date(f.kickoff) > new Date());
    round = Number(upcoming?.round || state.fixtures.at(-1)?.round || 1);
    render();
  } catch { loginView(); }
}

function predictionFor(fixture) {
  return state.predictions.find((p) => String(p.fixture_id) === String(fixture.id) && String(p.user_id) === String(state.user.id));
}

function render() {
  const isAdmin = state.user.role === "admin";
  app.innerHTML = `<header class="top"><div class="brand"><span class="ball">⚽</span><span>АПЛ Прогноз</span></div>
    <div class="account"><small>${esc(state.user.display_name)} · ${isAdmin ? "Администратор" : "Участник"}</small><button class="link" id="logout">Выйти</button></div></header>
    <section class="hero"><div><span class="kicker">Закрытая лига прогнозов</span><h1>Матчдэй ${round}</h1><p>Точный счёт — 5 · разница — 3 · исход — 2 · матч ×2</p></div>
      <nav class="tabs"><button data-tab="predictions" class="${tab === "predictions" ? "active" : ""}">Прогнозы</button><button data-tab="table" class="${tab === "table" ? "active" : ""}">Таблица</button>${isAdmin ? `<button data-tab="admin" class="${tab === "admin" ? "active" : ""}">Управление</button>` : ""}</nav></section>
    <main class="wrap">${state.user.must_change_password ? `<div class="notice">При первом входе смените временный пароль в разделе ${isAdmin ? "«Управление»" : "ниже"}.</div>` : ""}${content()}</main>`;
  document.querySelector("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); loginView(); };
  document.querySelectorAll("[data-tab]").forEach((button) => button.onclick = () => { tab = button.dataset.tab; render(); });
  bind();
}

function content() {
  if (tab === "table") return tableView();
  if (tab === "admin" && state.user.role === "admin") return adminView();
  const rounds = [...new Set(state.fixtures.map((f) => Number(f.round)))].sort((a, b) => a - b);
  const fixtures = state.fixtures.filter((f) => Number(f.round) === round);
  return `<div class="toolbar"><h2>Ваш прогноз</h2><select class="round-select" id="round">${rounds.map((r) => `<option ${r === round ? "selected" : ""}>${r}</option>`).join("")}</select></div>
    <div class="grid"><section class="panel">${fixtures.length ? fixtures.map(matchView).join("") : `<div class="empty">Календарь ещё не загружен. Администратору нужно нажать «Получить календарь».</div>`}</section>
    <aside class="panel side"><h3>Лидеры сезона</h3>${ranking()}</aside></div>`;
}

function matchView(fixture) {
  const p = predictionFor(fixture);
  const locked = new Date(fixture.kickoff) <= new Date();
  return `<article class="match ${locked ? "locked" : ""}" data-fixture="${fixture.id}">
    <div class="team home"><span>${esc(fixture.home_name)}</span><img class="crest" src="${esc(fixture.home_crest)}" alt=""></div>
    <div class="score"><div><input data-side="home" type="number" min="0" max="30" value="${p?.home_score ?? ""}" ${locked ? "disabled" : ""}><small>${new Date(fixture.kickoff).toLocaleString("ru-RU",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})}</small></div><b>:</b><input data-side="away" type="number" min="0" max="30" value="${p?.away_score ?? ""}" ${locked ? "disabled" : ""}></div>
    <div class="team"><img class="crest" src="${esc(fixture.away_crest)}" alt=""><span>${esc(fixture.away_name)}</span></div>
    <button class="bonus ${p?.bonus ? "on" : ""}" ${locked ? "disabled" : ""}>×2</button></article>`;
}

function ranking() {
  return state.ranking.length ? state.ranking.map((x, i) => `<div class="rank"><span>${i + 1}. ${esc(x.name)}</span><b>${x.total}</b></div>`).join("") : `<p class="sub">Очки появятся после первых результатов.</p>`;
}

function tableView() {
  return `<div class="toolbar"><h2>Общий зачёт</h2></div><section class="panel side">${ranking()}</section>`;
}

function adminView() {
  return `<div class="toolbar"><h2>Управление лигой</h2><button class="primary" id="sync">Получить календарь и результаты</button></div>
    <section class="panel"><form class="admin-form" id="new-user"><input name="displayName" placeholder="Имя участника" required><input name="login" placeholder="Логин латиницей" required><input name="temporaryPassword" placeholder="Временный пароль" required><button class="primary">Создать</button></form>
    <div class="users">${state.users.map((u) => `<div class="user-row"><span><b>${esc(u.display_name)}</b> · ${esc(u.login)}</span>${u.role === "admin" ? "<small>Администратор</small>" : `<button class="link toggle-user" data-id="${u.id}" data-active="${u.active}">${u.active ? "Заблокировать" : "Активировать"}</button>`}</div>`).join("")}</div></section>
    <section class="panel side" style="margin-top:20px"><h3>Смена моего пароля</h3><form id="password"><label class="field"><span>Новый пароль</span><input name="password" type="password" minlength="8" required></label><button class="primary">Сохранить</button></form></section>`;
}

function bind() {
  const roundSelect = document.querySelector("#round");
  if (roundSelect) roundSelect.onchange = () => { round = Number(roundSelect.value); render(); };
  document.querySelectorAll(".match").forEach((row) => {
    const save = async () => {
      const homeScore = row.querySelector('[data-side="home"]').value;
      const awayScore = row.querySelector('[data-side="away"]').value;
      if (homeScore === "" || awayScore === "") return;
      await api(`/api/predictions/${row.dataset.fixture}`, { method: "PUT", body: JSON.stringify({ homeScore, awayScore, bonus: row.querySelector(".bonus").classList.contains("on") }) });
      state = await api("/api/state");
    };
    row.querySelectorAll("input").forEach((input) => input.onchange = () => save().catch((e) => alert(e.message)));
    row.querySelector(".bonus").onclick = async (event) => { document.querySelectorAll(".bonus").forEach((b) => b.classList.remove("on")); event.currentTarget.classList.add("on"); await save(); render(); };
  });
  const sync = document.querySelector("#sync");
  if (sync) sync.onclick = async () => { sync.disabled = true; try { const r = await api("/api/admin/sync", { method: "POST" }); alert(`Обновлено матчей: ${r.updated}`); await load(); } catch (e) { alert(e.message); } finally { sync.disabled = false; } };
  const newUser = document.querySelector("#new-user");
  if (newUser) newUser.onsubmit = async (event) => { event.preventDefault(); try { await api("/api/admin/users", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(newUser))) }); await load(); tab = "admin"; render(); } catch (e) { alert(e.message); } };
  document.querySelectorAll(".toggle-user").forEach((button) => button.onclick = async () => { await api(`/api/admin/users/${button.dataset.id}`, { method: "PATCH", body: JSON.stringify({ active: button.dataset.active !== "true" }) }); await load(); tab = "admin"; render(); });
  const password = document.querySelector("#password");
  if (password) password.onsubmit = async (event) => { event.preventDefault(); try { await api("/api/change-password", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(password))) }); alert("Пароль изменён"); await load(); } catch (e) { alert(e.message); } };
}

load();
