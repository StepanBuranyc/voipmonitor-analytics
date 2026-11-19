import { setupTrend } from "/chart.mjs";
import { sentiments, statuses, topics } from "/catalog.mjs";

const byId = (id) => document.getElementById(id);
const all = (selector) => [...document.querySelectorAll(selector)];
const html = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]);
const csNumber = (value, digits = 0) => value == null ? "—" : Number(value).toLocaleString("cs-CZ", { maximumFractionDigits: digits, minimumFractionDigits: digits });
const percent = (value, digits = 0) => value == null ? "—" : `${csNumber(value, digits)} %`;
const longDay = new Intl.DateTimeFormat("cs-CZ", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" });
const shortDay = new Intl.DateTimeFormat("cs-CZ", { timeZone: "UTC", day: "numeric", month: "numeric" });
const date = (day, format = shortDay) => format.format(new Date(day));
const dateSpan = (from, to) => !from || !to ? "" : from === to ? date(to, longDay) : `${date(from)} – ${date(to, longDay)}`;
const elapsed = (seconds) => {
  if (seconds == null) return "—";
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

const state = {
  view: "dashboard", dataset: "demo", from: "", to: "", branch: "",
  topic: "", sentiment: "", q: "", page: 1, report: null,
  config: { localModels: false, models: [] }, model: "",
};
let revision = 0;
let closeChart = null;
let pollTimer = null;
let voipTimer = null;
let voipRun = null;
let voipDisplay = "";
let detailKey = null;
let detailCall = null;
let detailRequest = 0;
const titleFor = { dashboard: "Přehled hovorů", calls: "Hovory", import: "Import dat" };
const sourceLabel = { demo: "Ukázkové hovory", pilot: "Importované hovory" };

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Požadavek se nezdařil.");
  return data;
}
const post = (path, data) => api(path, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
});

function tell(message = "", error = false) {
  const target = byId("global-status");
  target.textContent = message;
  target.classList.toggle("error", error);
  target.hidden = !message;
}

function params(includeCallFilters = false) {
  const result = new URLSearchParams({ dataset: state.dataset });
  const fields = ["from", "to", "branch"];
  if (includeCallFilters) fields.push("topic", "sentiment", "q");
  for (const field of fields) {
    if (state[field]) result.set(field, state[field]);
  }
  return result;
}

function options(catalog, value) {
  return Object.entries(catalog).map(([id, label]) =>
    `<option value="${html(id)}"${id === value ? " selected" : ""}>${html(label)}</option>`).join("");
}

function updateFilters(report) {
  state.from = report.from;
  state.to = report.to;
  byId("date-from").value = state.from;
  byId("date-to").value = state.to;
  byId("branch").innerHTML = '<option value="">Všechny pobočky</option>' +
    report.branches.map((branch) => `<option value="${html(branch)}">${html(branch)}</option>`).join("");
  byId("branch").value = state.branch;
  byId("search").value = state.q;
  byId("topic-filter").value = state.topic;
  byId("sentiment-filter").value = state.sentiment;
}

const icon = (name) => `<span class="icon icon-${name}" aria-hidden="true"></span>`;
const pill = (value, labels) => value ? `<span class="label-pill ${html(value)}">${html(labels[value])}</span>` : "—";

function delta(value, suffix, favorable) {
  if (value == null) return "";
  const digits = suffix === " p. b." ? 1 : suffix === " MOS" ? 2 : 0;
  const quietZero = Math.abs(value) < 0.5 * 10 ** -digits;
  const text = quietZero ? `0${suffix}` : `${value > 0 ? "+" : "−"}${csNumber(Math.abs(value), digits)}${suffix}`;
  const color = favorable == null || quietZero ? "" : ((value > 0) === favorable ? " positive" : " negative");
  return `<span class="delta${color}">${text}</span>`;
}
const difference = (a, b) => a == null || b == null ? null : a - b;

function metric(label, value, note, change, symbol, color = "") {
  return `<article class="card metric">
    <div class="metric-top"><strong>${label}</strong><span class="metric-icon ${color}">${icon(symbol)}</span></div>
    <div class="metric-value">${value}</div>
    <div class="metric-note">${change}<span>${note}</span></div>
  </article>`;
}

function empty(title, message, action = "") {
  return `<div class="empty"><h2>${title}</h2><p>${message}</p>${action}</div>`;
}

function table(calls, showStatus = false) {
  return `<div class="table-scroll" tabindex="0" role="region" aria-label="Tabulka hovorů"><table>
    <thead><tr><th scope="col">Hovor</th><th scope="col">Začátek</th><th scope="col">Pobočka</th>
    <th scope="col">Téma</th><th scope="col">Sentiment</th><th scope="col">MOS</th>${showStatus ? '<th scope="col">Stav</th>' : ""}</tr></thead>
    <tbody>${calls.map((call) => `<tr>
      <td><button type="button" class="call-title" data-call="${html(call.key)}">${html(call.title ?? call.cdrId)}</button>
      ${call.title ? `<span class="call-id">${html(call.cdrId)}</span>` : ""}</td>
      <td class="cell-time">${date(call.startedAt.slice(0, 10))} ${call.startedAt.slice(11, 16)}</td>
      <td>${html(call.branch || "—")}</td><td>${html(topics[call.topic] ?? "—")}</td>
      <td>${pill(call.sentiment, sentiments)}</td><td class="cell-number">${csNumber(call.mos, 2)}</td>
      ${showStatus ? `<td>${pill(call.status, statuses)}</td>` : ""}
    </tr>`).join("")}</tbody></table></div>`;
}

function renderDashboard(report) {
  const dashboard = byId("dashboard");
  closeChart?.();
  closeChart = null;
  if (!report.latest) {
    dashboard.innerHTML = `<div class="card">${empty("Zatím bez importovaných hovorů", "Přidejte CDR a nahrávky z VoIPmonitoru.",
      '<button type="button" class="button button-primary" data-view="import">Importovat data</button>')}</div>`;
    return;
  }
  const { current, previous, topTopics, recent, series } = report;
  const volumeDelta = previous?.total ? (current.total - previous.total) / previous.total * 100 : null;
  const comparisonNote = previous ? "oproti minulému období" : "ve vybraném období";
  const topicMarkup = topTopics.length ? `<ol class="topic-list">${topTopics.map(({ id, count, share, delta: shareDelta }) =>
    `<li><button type="button" class="topic-button" data-topic="${id}" title="Zobrazit hovory k tématu">
      <span class="topic-name">${topics[id]}</span><span class="topic-number"><small>${csNumber(count)} · </small>${percent(share)}
      ${delta(shareDelta, " p. b.")}</span><progress class="topic-progress" max="100" value="${share}" aria-hidden="true"></progress>
    </button></li>`).join("")}</ol>` :
    empty("Zatím bez témat", "Témata se zobrazí po dokončení analýzy hovorů.");
  const sentimentCounts = Object.keys(sentiments).filter((key) => current.sentimentCounts[key]);
  const sentimentStrip = sentimentCounts.length ? `<div class="sentiment-strip" aria-label="Rozložení sentimentu">
    ${sentimentCounts.map((key) => `<span>${sentiments[key]} <strong>${percent(100 * current.sentimentCounts[key] / current.analyzed)}</strong></span>`).join("")}
  </div>` : "";
  dashboard.innerHTML = `
    <div class="metrics-grid">
      ${metric("Hovory celkem", csNumber(current.total), comparisonNote, delta(volumeDelta, " %"), "wave")}
      ${metric("Analyzováno", csNumber(current.analyzed), current.completeRate == null ? "pokrytí analýzou" : `${percent(current.completeRate)} všech hovorů`, "", "check", "green")}
      ${metric("Negativní sentiment", percent(current.negativeRate, 1), "z analyzovaných hovorů", delta(difference(current.negativeRate, previous?.negativeRate), " p. b.", false), "face", "red")}
      ${metric("Průměrný MOS", csNumber(current.avgMos, 2), `z ${csNumber(current.mosCount)} měření`, delta(difference(current.avgMos, previous?.avgMos), " MOS", true), "wave", "blue")}
    </div>
    <div class="report-grid">
      <section class="card panel" aria-label="Vývoj hovorů">
        <div class="panel-head"><div><h2>Vývoj hovorů</h2><p>${series.length && series[0].from !== series[0].to ? "Po týdnech" : "Po dnech"} ve vybraném období</p></div></div>
        <div class="legend"><span><i class="legend-marker"></i>Všechny hovory</span><span><i class="legend-marker analyzed"></i>Analyzované</span></div>
        <div class="chart-wrap">
          <canvas class="trend-chart" role="img" aria-label="Spojnicový graf všech a analyzovaných hovorů. Hodnoty jsou v seznamu pod grafem."></canvas>
          <div class="chart-tooltip" hidden></div>
        </div>
        <details class="chart-data"><summary>Hodnoty v grafu</summary><ul>${series.map((item) => 
          `<li>${dateSpan(item.from, item.to)} · ${csNumber(item.total)} hovorů · ${csNumber(item.analyzed)} analyzováno</li>`).join("")}</ul></details>
        ${sentimentStrip}
      </section>
      <section class="card panel" aria-label="Témata hovorů">
        <div class="panel-head"><div><h2>Témata hovorů</h2><p>Podíl z analyzovaných hovorů${previous?.analyzed ? " a změna v procentních bodech" : ""}</p></div></div>
        ${topicMarkup}
      </section>
    </div>
    <section class="card table-panel" aria-label="Nedávné hovory">
      <div class="panel-head table-heading"><h2>Nedávné hovory</h2><button type="button" class="link-button" data-view="calls" data-clear-filters>Zobrazit všechny hovory</button></div>
      ${recent.length ? table(recent) : empty("V tomto období nejsou hovory", "Změňte období nebo pobočku ve filtrech.")}
    </section>`;
  if (series.length) closeChart = setupTrend(dashboard.querySelector("canvas"), series, dashboard.querySelector(".chart-tooltip"));
}

function renderModels(report) {
  const panel = byId("models-panel");
  if (state.dataset === "demo" || !report.latest) {
    panel.replaceChildren();
    return;
  }
  const config = state.config;
  if (!config.localModels) {
    panel.innerHTML = '<div class="card models-panel"><div><strong>Lokální analýza čeká na nastavení</strong><p>Spusťte Whisper a Ollama podle návodu k pilotu. Import a přehrávání jsou dostupné.</p></div></div>';
    return;
  }
  const { waiting, active } = report.queue;
  panel.innerHTML = `<div class="card models-panel"><div><strong>Lokální modely</strong>
     <p>Čeká na analýzu nebo opakování ${csNumber(waiting)} · Ve frontě a zpracování ${csNumber(active)}</p></div>
     <form id="queue-form"><label><span class="sr-only">Model pro analýzu</span><select id="model-select">
       ${options(Object.fromEntries(config.models.map((model) => [model, model])), state.model)}</select></label>
       <button type="submit" class="button button-primary"${waiting ? "" : " disabled"}>Analyzovat čekající</button>
     </form></div>`;
}

function renderCalls(data, report) {
  const pane = byId("calls-result");
  renderModels(report);
  if (data.total && !data.calls.length && state.page > 1) {
    state.page = 1;
    void refresh();
    return;
  }
  if (!data.calls.length) {
    pane.innerHTML = empty("Žádné hovory", report.latest ? "Změňte období nebo filtry." : "Začněte importem CDR a anonymizovaných WAV.",
      report.latest ? "" : '<button type="button" class="button button-primary" data-view="import">Importovat data</button>');
    return;
  }
  const first = (data.page - 1) * data.pageSize + 1;
  const last = first + data.calls.length - 1;
  pane.innerHTML = `${table(data.calls, true)}<div class="pager">
    <span>${csNumber(first)}–${csNumber(last)} z ${csNumber(data.total)} hovorů</span>
    <div><button class="button button-outline" type="button" data-page="${data.page - 1}"${first === 1 ? " disabled" : ""}>Předchozí</button>
    <button class="button button-outline" type="button" data-page="${data.page + 1}"${last >= data.total ? " disabled" : ""}>Další</button></div></div>`;
}

async function refresh(background = false) {
  if (state.view === "import") return;
  const request = ++revision;
  clearTimeout(pollTimer);
  const pane = byId(state.view === "dashboard" ? "dashboard" : "calls-result");
  if (!background) pane.setAttribute("aria-busy", "true");
  try {
    const report = await api(`/api/report?${params()}`);
    if (request !== revision) return;
    state.report = report;
    if (!background) updateFilters(report);
    const activeSource = sourceLabel[state.dataset];
    byId("page-note").textContent = report.previous && state.view === "dashboard"
      ? `${activeSource} · Srovnání s obdobím ${dateSpan(report.prior.from, report.prior.to)}`
      : activeSource;
    if (state.view === "dashboard") {
      renderDashboard(report);
    } else {
      const query = params(true);
      if (report.from) query.set("from", report.from);
      if (report.to) query.set("to", report.to);
      query.set("page", state.page);
      const calls = await api(`/api/calls?${query}`);
      if (request !== revision) return;
      renderCalls(calls, report);
    }
    if (background && detailKey && detailCall && ["queued", "processing"].includes(detailCall.status)) {
      const updated = await api(`/api/calls/${detailKey}`);
      if (request === revision && detailKey === updated.key && updated.status !== detailCall.status) renderDetail(updated);
    }
    if (state.dataset === "pilot" && report.queue.active) pollTimer = setTimeout(() => void refresh(true), 2200);
  } catch (error) {
    if (request === revision) tell(error.message, true);
  } finally {
    if (request === revision) pane.setAttribute("aria-busy", "false");
  }
}

function showView(view, focus = true) {
  if (!Object.hasOwn(titleFor, view)) return;
  state.view = view;
  revision += 1;
  clearTimeout(pollTimer);
  clearTimeout(voipTimer);
  tell();
  const heading = byId("page-title");
  heading.textContent = titleFor[view];
  byId("page-note").textContent = view === "import" ? "Anonymizované nahrávky a výpis CDR" : sourceLabel[state.dataset];
  byId("period-filters").hidden = view === "import";
  byId("open-export").hidden = view === "import";
  byId("open-import").hidden = view === "import";
  for (const id of Object.keys(titleFor)) byId(id).hidden = id !== view;
  for (const button of all("nav button[data-view]")) {
    if (button.dataset.view === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (focus) byId("content").focus({ preventScroll: true });
  if (view === "import") void updateVoipImport();
  else void refresh();
}

function setDataset(dataset) {
  state.dataset = dataset;
  state.report = null;
  byId("dataset").value = dataset;
  Object.assign(state, { from: "", to: "", branch: "", topic: "", sentiment: "", q: "", page: 1 });
}

function renderDetail(call) {
  detailCall = call;
  const analysis = call.analysis;
  byId("detail-title").textContent = analysis?.title || `Hovor ${call.cdrId}`;
  byId("detail-meta").textContent = [call.cdrId, date(call.startedAt.slice(0, 10), longDay),
    call.startedAt.slice(11, 16), call.branch || (call.sensor ? `Sonda ${call.sensor}` : "")].filter(Boolean).join(" · ");
  const canAnalyze = state.config.localModels && call.dataset === "pilot" && call.hasAudio &&
    ["ready", "error", "complete"].includes(call.status);
  byId("detail-content").innerHTML = `
    <div class="detail-badges">${call.topic ? `<span class="label-pill">${topics[call.topic]}</span>` : ""}
      ${analysis ? pill(analysis.sentiment, sentiments) : ""}${pill(call.status, statuses)}</div>
    <div class="detail-meta-grid">
      ${call.duration == null ? "" : `<span>Délka <strong>${elapsed(call.duration)}</strong></span>`}
      ${call.mos == null ? "" : `<span>MOS <strong>${csNumber(call.mos, 2)}</strong></span>`}
      ${call.jitter == null ? "" : `<span>Jitter <strong>${csNumber(call.jitter, 1)} ms</strong></span>`}
      ${call.loss == null ? "" : `<span>Ztráta <strong>${percent(call.loss, 2)}</strong></span>`}
    </div>
    ${analysis ? `<section class="detail-block"><h3>Souhrn</h3><p>${html(analysis.summary)}</p>
      <dl><dt>Požadavek</dt><dd>${html(analysis.request)}</dd><dt>Výsledek</dt><dd>${html(analysis.outcome)}</dd>
      <dt>Model</dt><dd>${html(analysis.model)}</dd></dl>
      ${call.status === "complete" ? `<label>Opravit téma <select id="edit-topic">${options(topics, call.topic)}</select></label>` : ""}
    </section>` : ""}
    <section class="detail-block"><h3>Nahrávka</h3>
      ${call.hasAudio ? `<audio id="recording" controls preload="metadata" src="/api/calls/${html(call.key)}/audio"></audio>` : "<p>Nahrávka není k dispozici.</p>"}
    </section>
    <section class="detail-block"><h3>Přepis</h3>
      ${call.transcript?.length ? `<ol class="detail-transcript">${call.transcript.map((segment, index) => {
        const evidence = analysis?.evidence?.includes(index);
        return `<li${evidence ? ' class="evidence"' : ""}>
          ${call.hasAudio ? `<button type="button" class="link-button" data-seek="${segment.seconds}" aria-label="Přehrát od ${elapsed(segment.seconds)}">${elapsed(segment.seconds)}</button>` : `<span>${elapsed(segment.seconds)}</span>`}
          <div>${segment.speaker || evidence ? `<strong>${[segment.speaker, evidence ? "Podklad souhrnu" : ""].filter(Boolean).map(html).join(" · ")}</strong>` : ""}${html(segment.text)}</div></li>`;
      }).join("")}</ol>` : "<p>Přepis zatím není k dispozici.</p>"}
      ${call.error ? `<p class="notice error" role="status">${html(call.error)}</p>` : ""}
      ${canAnalyze ? `<form id="detail-queue-form" class="detail-actions">
        <label>Model <select id="detail-model">${options(Object.fromEntries(state.config.models.map((model) => [model, model])), state.model)}</select></label>
        <button class="button button-primary" type="submit">${analysis ? "Analyzovat znovu" : "Analyzovat hovor"}</button>
      </form>` : ""}
    </section>`;
}

async function openDetail(key) {
  const dialog = byId("detail-dialog");
  const request = ++detailRequest;
  detailKey = key;
  detailCall = null;
  byId("detail-title").textContent = "Detail hovoru";
  byId("detail-meta").textContent = "VoIPmonitor";
  byId("detail-content").textContent = "Načítám hovor…";
  if (!dialog.open) dialog.showModal();
  try {
    const call = await api(`/api/calls/${key}`);
    if (request === detailRequest) renderDetail(call);
  } catch (error) {
    if (request === detailRequest) byId("detail-content").textContent = error.message;
  }
}

async function queueJobs(key, model, button) {
  button.disabled = true;
  try {
    const { queued } = await post("/api/analyze", key ? { key, model } : { model });
    state.model = model;
    tell(queued ? `Do fronty bylo přidáno ${csNumber(queued)} hovorů.` : "Žádné hovory nebyly přidány do fronty.");
    if (key && detailKey === key) await openDetail(key);
    await refresh();
  } catch (error) {
    if (key && detailKey === key) {
      const notice = document.createElement("p");
      notice.className = "notice error";
      notice.role = "status";
      notice.textContent = error.message;
      byId("detail-content").append(notice);
    } else tell(error.message, true);
  } finally {
    button.disabled = false;
  }
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.view) {
    if (button.hasAttribute("data-open-voip") && voipRun) {
      setDataset("pilot");
      Object.assign(state, { from: voipRun.from, to: voipRun.to });
    }
    if (button.hasAttribute("data-clear-filters")) Object.assign(state, { topic: "", sentiment: "", q: "" });
    if (button.dataset.view === "calls" && state.view !== "calls") state.page = 1;
    return showView(button.dataset.view);
  }
  if (button.dataset.topic) {
    Object.assign(state, { topic: button.dataset.topic, sentiment: "", q: "", page: 1 });
    return showView("calls");
  }
  if (button.dataset.call) return void openDetail(button.dataset.call);
  if (button.dataset.page) {
    state.page = Number(button.dataset.page);
    return void refresh();
  }
  if (button.dataset.seek != null) {
    const audio = byId("recording");
    if (!audio) return;
    audio.currentTime = Number(button.dataset.seek);
    void audio.play().catch(() => {});
  }
});

byId("detail-dialog").addEventListener("close", () => {
  byId("recording")?.pause();
  detailKey = null;
  detailCall = null;
  detailRequest += 1;
});
byId("detail-content").addEventListener("change", async (event) => {
  if (event.target.id !== "edit-topic" || !detailCall) return;
  const call = detailCall;
  const select = event.target;
  try {
    const { topic } = await post(`/api/calls/${call.key}/topic`, { topic: select.value });
    if (detailKey === call.key) {
      call.topic = topic;
      const badge = byId("detail-content").querySelector(".detail-badges .label-pill");
      if (badge) badge.textContent = topics[topic];
    }
    tell("Téma hovoru bylo upraveno.");
    await refresh();
  } catch (error) {
    select.value = call.topic;
    const notice = document.createElement("p");
    notice.className = "notice error";
    notice.role = "status";
    notice.textContent = error.message;
    byId("detail-content").append(notice);
  }
});

byId("dataset").addEventListener("change", (event) => {
  setDataset(event.target.value);
  showView(state.view === "import" ? "dashboard" : state.view);
});
byId("open-import").addEventListener("click", () => showView("import"));
byId("open-export").addEventListener("click", () => {
  byId("export-description").textContent = `${sourceLabel[state.dataset]} se stáhnou podle aktuálního období a filtrů.`;
  byId("export-dialog").showModal();
});
byId("export-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = params(state.view === "calls");
  if (new FormData(event.currentTarget).has("includeTranscript")) query.set("includeTranscript", "1");
  const link = document.createElement("a");
  link.href = `/api/export.csv?${query}`;
  link.download = "voipmonitor-hovory.csv";
  link.click();
  byId("export-dialog").close();
});
byId("period-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const from = form.get("from");
  const to = form.get("to");
  if (from && to && (from > to || Date.parse(to) - Date.parse(from) > 365 * 86_400_000)) {
    return tell("Zadejte platné období do 366 dnů.", true);
  }
  Object.assign(state, { from, to, branch: form.get("branch"), page: 1 });
  tell();
  void refresh();
});
byId("latest-month").addEventListener("click", () => {
  Object.assign(state, { from: "", to: "", page: 1 });
  tell();
  void refresh();
});
byId("call-filters").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  Object.assign(state, Object.fromEntries(form), { page: 1 });
  tell();
  void refresh();
});
byId("models-panel").addEventListener("change", (event) => {
  if (event.target.id === "model-select") state.model = event.target.value;
});
byId("models-panel").addEventListener("submit", (event) => {
  if (event.target.id !== "queue-form") return;
  event.preventDefault();
  void queueJobs(null, byId("model-select").value, event.submitter);
});
byId("detail-content").addEventListener("submit", (event) => {
  if (event.target.id !== "detail-queue-form" || !detailKey) return;
  event.preventDefault();
  void queueJobs(detailKey, byId("detail-model").value, event.submitter);
});

function renderVoipImport(data) {
  const form = byId("voip-form");
  const note = byId("api-source-note");
  const result = byId("voip-result");
  form.hidden = !data.configured;
  note.textContent = data.configError || (data.configured
    ? `Vyberte nejvýše ${data.maxDays} dnů. VoIPmonitor poskytne nahrávky ve své uložené podobě.`
    : "Nastavte adresu GUI a místní účet VoIPmonitoru v .env.local podle README.");
  const job = data.run;
  result.hidden = !job;
  byId("submit-voip").disabled = job?.state === "running";
  voipRun = job;
  const snapshot = JSON.stringify(job);
  if (!job || snapshot === voipDisplay) return;
  voipDisplay = snapshot;
  const keepDetailsOpen = result.querySelector("details")?.open;
  result.classList.toggle("form-error", job.state === "error");
  const heading = {
    running: `Načítám ${job.day ? date(job.day, longDay) : "hovory"}`,
    complete: job.issueCount ? "Import dokončen s upozorněními" : "Import z VoIPmonitoru dokončen",
    error: "Import z VoIPmonitoru se zastavil",
  }[job.state];
  result.innerHTML = `<strong>${heading}</strong>
    <p>Nové CDR ${csNumber(job.added)} · Již uložené ${csNumber(job.existing)} ·
    S nahrávkou ${csNumber(job.withAudio)} · Bez nahrávky ${csNumber(job.withoutAudio)}</p>
    ${job.state === "running" ? `<progress max="${job.days}" value="${job.processedDays}" aria-label="Zpracované dny"></progress>` : ""}
    ${job.error ? `<p>${html(job.error)}</p>` : ""}
    ${job.issues.length ? `<details${keepDetailsOpen ? " open" : ""}><summary>Upozornění (${csNumber(job.issueCount)})</summary>
      <ul>${job.issues.map(({ day, cdrId, message }) =>
        `<li>${date(day)}${cdrId ? ` · CDR ${html(cdrId)}` : ""} · ${html(message)}</li>`).join("")}</ul></details>` : ""}
    ${job.state !== "running" && job.added + job.existing ? '<button class="button button-primary" type="button" data-view="calls" data-open-voip>Otevřít hovory z období</button>' : ""}`;
}

async function updateVoipImport() {
  clearTimeout(voipTimer);
  if (state.view !== "import") return;
  try {
    const data = await api("/api/voipmonitor");
    if (state.view !== "import") return;
    renderVoipImport(data);
    if (data.run?.state === "running") voipTimer = setTimeout(() => void updateVoipImport(), 1300);
  } catch (error) {
    byId("api-source-note").textContent = error.message;
  }
}

const pragueToday = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague", dateStyle: "short" }).format(new Date());
const voipForm = byId("voip-form");
voipForm.elements.from.value = pragueToday;
voipForm.elements.to.value = pragueToday;
voipForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearTimeout(voipTimer);
  const submit = byId("submit-voip");
  submit.disabled = true;
  tell();
  const form = new FormData(event.currentTarget);
  try {
    const data = await post("/api/voipmonitor", {
      from: form.get("from"), to: form.get("to"), sensor: form.get("sensor"), recordings: form.has("recordings"),
    });
    renderVoipImport(data);
    if (state.view === "import") void updateVoipImport();
  } catch (error) {
    submit.disabled = false;
    tell(error.message, true);
  }
});

byId("import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = byId("submit-import");
  const result = byId("import-result");
  submit.disabled = true;
  result.classList.remove("form-error");
  result.hidden = false;
  result.textContent = "Páruji soubory…";
  const payload = new FormData(form);
  if (!payload.get("wav")?.name) payload.delete("wav");
  try {
    const outcome = await api("/api/import", { method: "POST", body: payload });
    const hasCalls = outcome.added + outcome.existing > 0;
    if (hasCalls) setDataset("pilot");
    result.innerHTML = `<strong>${hasCalls ? "Import dokončen" : "Import neobsahoval platné CDR"}</strong>
      <p>Nové CDR ${csNumber(outcome.added)} · Již uložené ${csNumber(outcome.existing)} · S nahrávkou ${csNumber(outcome.matched)} · Bez nahrávky ${csNumber(outcome.missing)}</p>
      ${outcome.issues.length ? `<ul>${outcome.issues.map((issue) => `<li>${html(issue.row ? `CDR řádek ${issue.row}` : issue.file)} · ${html(issue.message)}</li>`).join("")}</ul>` : ""}
      ${hasCalls ? '<button type="button" class="button button-primary" data-view="calls">Otevřít hovory</button>' : ""}`;
    if (hasCalls) form.reset();
  } catch (error) {
    result.classList.add("form-error");
    result.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

byId("topic-filter").insertAdjacentHTML("beforeend", options(topics));
byId("sentiment-filter").insertAdjacentHTML("beforeend", options(sentiments));
try {
  state.config = await api("/api/config");
  state.model = state.config.models[0] ?? "";
} catch (error) {
  tell(error.message, true);
}
showView("dashboard", false);
