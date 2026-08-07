const root = document.querySelector("#app");
const labels = { new: "Новые", in_progress: "В работе", control: "На контроле", done: "Выполнено" };
const priorities = { normal: "Обычный", high: "Высокий", critical: "Критический" };
let data;
let mode = localStorage.getItem("dela-mode") || "board";
let query = "";
let statusFilter = "all";

const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
async function api(url, options = {}) {
  const response = await fetch(url, { headers: { "Content-Type": "application/json" }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Ошибка");
  return body;
}

function fmt(value, dateOnly = false) {
  if (!value) return "";
  return new Date(value).toLocaleString("ru-RU", dateOnly ? { day: "2-digit", month: "short", year: "numeric" } : { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function visibleTasks() {
  const term = query.trim().toLowerCase();
  return data.tasks.filter((task) => (statusFilter === "all" || task.status === statusFilter) && (!term || `${task.title} ${task.description}`.toLowerCase().includes(term)));
}

function taskCard(task) {
  const overdue = task.due_date && task.status !== "done" && new Date(task.due_date) < new Date();
  return `<article class="task priority-${task.priority}" draggable="true" data-task="${task.id}">
    <header><span class="priority">${priorities[task.priority]}</span><button class="icon edit-task" data-id="${task.id}" aria-label="Изменить">•••</button></header>
    <h3>${esc(task.title)}</h3>${task.description ? `<p>${esc(task.description)}</p>` : ""}
    <footer>${task.due_date ? `<time class="${overdue ? "overdue" : ""}">${overdue ? "Просрочено · " : "до "}${fmt(task.due_date, true)}</time>` : `<span>Без срока</span>`}<small>${esc(task.updated_by)}</small></footer>
  </article>`;
}

function board() {
  const tasks = visibleTasks();
  return `<section class="board">${Object.entries(labels).map(([key, label]) => {
    const items = tasks.filter((t) => t.status === key);
    return `<div class="column" data-drop="${key}"><header><h2>${label}</h2><b>${items.length}</b></header><div class="cards">${items.map(taskCard).join("") || `<div class="empty">Нет задач</div>`}</div></div>`;
  }).join("")}</section>`;
}

function list() {
  return `<section class="task-list"><div class="list-head"><span>Задача</span><span>Статус</span><span>Приоритет</span><span>Срок</span></div>${visibleTasks().map((t) => `<article data-task="${t.id}"><div><b>${esc(t.title)}</b><small>${esc(t.description)}</small></div><span>${labels[t.status]}</span><span class="priority priority-${t.priority}">${priorities[t.priority]}</span><time>${t.due_date ? fmt(t.due_date, true) : "—"}</time><button class="icon edit-task" data-id="${t.id}">•••</button></article>`).join("") || `<div class="empty large">Задачи не найдены</div>`}</section>`;
}

function render() {
  const open = data.tasks.filter((x) => x.status !== "done").length;
  const overdue = data.tasks.filter((x) => x.status !== "done" && x.due_date && new Date(x.due_date) < new Date()).length;
  const critical = data.tasks.filter((x) => x.status !== "done" && x.priority === "critical").length;
  root.innerHTML = `<header class="top"><a class="brand" href="/dela"><span>Д</span><div><b>Дела</b><small>Рабочий дашборд</small></div></a><nav><a href="/">Прогнозы</a><button class="ghost" id="history">История</button><span>${esc(data.user.display_name)}</span><button class="ghost" id="logout">Выйти</button></nav></header>
  <main><section class="heading"><div><p>Оперативная сводка</p><h1>Дела и контроль</h1><span>Общие задачи и новости для руководителя и команды</span></div><div class="actions"><button class="secondary" id="add-news">Добавить новость</button><button class="primary" id="add-task">Новая задача</button></div></section>
  <section class="stats"><article><small>Открытые задачи</small><b>${open}</b></article><article><small>В работе</small><b>${data.tasks.filter((x) => x.status === "in_progress").length}</b></article><article class="${overdue ? "danger" : ""}"><small>Просрочено</small><b>${overdue}</b></article><article class="${critical ? "warning" : ""}"><small>Критический приоритет</small><b>${critical}</b></article></section>
  <section class="workspace"><div class="tasks-area"><div class="toolbar"><div class="view"><button data-mode="board" class="${mode === "board" ? "active" : ""}">Канбан</button><button data-mode="list" class="${mode === "list" ? "active" : ""}">Список</button></div><input id="search" value="${esc(query)}" placeholder="Поиск по задачам"><select id="status"><option value="all">Все статусы</option>${Object.entries(labels).map(([v,l]) => `<option value="${v}" ${statusFilter === v ? "selected" : ""}>${l}</option>`).join("")}</select></div>${mode === "board" ? board() : list()}</div>
  <aside class="news"><header><div><p>Информационная лента</p><h2>Новости</h2></div><b>${data.news.length}</b></header><div class="news-list">${data.news.map((x) => `<article><time>${fmt(x.published_at)}</time><h3>${esc(x.title)}</h3>${x.body ? `<p>${esc(x.body)}</p>` : ""}<footer>${x.link ? `<a href="${esc(x.link)}" target="_blank" rel="noopener">Открыть источник</a>` : `<span>${esc(x.author)}</span>`}<span><button class="icon edit-news" data-id="${x.id}">•••</button><button class="icon delete-news" data-id="${x.id}">×</button></span></footer></article>`).join("") || `<div class="empty large">Новостей пока нет</div>`}</div></aside></section></main>`;
  bind();
}

function dialog(title, content, submitText = "Сохранить") {
  const box = document.createElement("dialog");
  box.innerHTML = `<form method="dialog"><header><h2>${title}</h2><button value="cancel" class="icon">×</button></header>${content}<footer><button value="cancel" class="secondary">Отмена</button><button value="default" class="primary submit">${submitText}</button></footer></form>`;
  document.body.append(box); box.showModal(); box.addEventListener("close", () => box.remove()); return box;
}

function taskDialog(task = {}) {
  const box = dialog(task.id ? "Изменить задачу" : "Новая задача", `<label>Название<input name="title" value="${esc(task.title)}" required maxlength="180"></label><label>Описание<textarea name="description" rows="4">${esc(task.description)}</textarea></label><div class="form-grid"><label>Статус<select name="status">${Object.entries(labels).map(([v,l]) => `<option value="${v}" ${task.status === v ? "selected" : ""}>${l}</option>`).join("")}</select></label><label>Приоритет<select name="priority">${Object.entries(priorities).map(([v,l]) => `<option value="${v}" ${task.priority === v ? "selected" : ""}>${l}</option>`).join("")}</select></label></div><label>Срок<input name="dueDate" type="datetime-local" value="${task.due_date ? new Date(new Date(task.due_date).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0,16) : ""}"></label>${task.id ? `<button type="button" class="delete" id="delete-task">Удалить задачу</button>` : ""}`);
  box.querySelector("form").addEventListener("submit", async (e) => { if (e.submitter?.value === "cancel") return; e.preventDefault(); const body = Object.fromEntries(new FormData(e.currentTarget)); await api(task.id ? `/api/dela/tasks/${task.id}` : "/api/dela/tasks", { method: task.id ? "PATCH" : "POST", body: JSON.stringify(body) }); box.close(); await load(); });
  box.querySelector("#delete-task")?.addEventListener("click", async () => { if (!confirm("Удалить задачу?")) return; await api(`/api/dela/tasks/${task.id}`, { method: "DELETE" }); box.close(); await load(); });
}

function newsDialog(item = {}) {
  const box = dialog(item.id ? "Изменить новость" : "Добавить новость", `<label>Заголовок<input name="title" value="${esc(item.title)}" required></label><label>Текст<textarea name="text" rows="5">${esc(item.body)}</textarea></label><label>Ссылка<input name="link" type="url" value="${esc(item.link)}" placeholder="https://"></label>`, item.id ? "Сохранить" : "Добавить");
  box.querySelector("form").addEventListener("submit", async (e) => { if (e.submitter?.value === "cancel") return; e.preventDefault(); await api(item.id ? `/api/dela/news/${item.id}` : "/api/dela/news", { method: item.id ? "PATCH" : "POST", body: JSON.stringify(Object.fromEntries(new FormData(e.currentTarget))) }); box.close(); await load(); });
}

function historyDialog() {
  dialog("История изменений", `<div class="history">${data.history.map((x) => `<article><time>${fmt(x.created_at)}</time><div><b>${esc(x.action)}</b><span>${esc(x.actor_name)}${x.details?.title ? ` · ${esc(x.details.title)}` : ""}</span></div></article>`).join("") || "История пока пуста"}</div>`);
}

function bind() {
  document.querySelectorAll("[data-mode]").forEach((x) => x.onclick = () => { mode = x.dataset.mode; localStorage.setItem("dela-mode", mode); render(); });
  document.querySelector("#search").oninput = (e) => { query = e.target.value; render(); document.querySelector("#search").focus(); };
  document.querySelector("#status").onchange = (e) => { statusFilter = e.target.value; render(); };
  document.querySelector("#add-task").onclick = () => taskDialog();
  document.querySelector("#add-news").onclick = newsDialog;
  document.querySelector("#history").onclick = historyDialog;
  document.querySelector("#logout").onclick = async () => { await api("/api/logout", { method: "POST" }); location.href = "/"; };
  document.querySelectorAll(".edit-task").forEach((x) => x.onclick = () => taskDialog(data.tasks.find((t) => String(t.id) === x.dataset.id)));
  document.querySelectorAll(".delete-news").forEach((x) => x.onclick = async () => { if (confirm("Удалить новость?")) { await api(`/api/dela/news/${x.dataset.id}`, { method: "DELETE" }); await load(); } });
  document.querySelectorAll(".edit-news").forEach((x) => x.onclick = () => newsDialog(data.news.find((n) => String(n.id) === x.dataset.id)));
  document.querySelectorAll(".task").forEach((x) => x.ondragstart = (e) => e.dataTransfer.setData("text/plain", x.dataset.task));
  document.querySelectorAll("[data-drop]").forEach((x) => { x.ondragover = (e) => e.preventDefault(); x.ondrop = async (e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/plain"); const task = data.tasks.find((t) => String(t.id) === id); if (task && task.status !== x.dataset.drop) { await api(`/api/dela/tasks/${id}`, { method: "PATCH", body: JSON.stringify({ status: x.dataset.drop }) }); await load(); } }; });
}

async function load() {
  try { data = await api("/api/dela/state"); render(); }
  catch (error) { root.innerHTML = `<main class="denied"><h1>Дела</h1><p>${esc(error.message)}</p><a href="/">Вернуться на сайт прогнозов</a></main>`; }
}
load();
