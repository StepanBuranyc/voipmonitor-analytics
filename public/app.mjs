import { setupTrend } from "/chart.mjs";
import { sentiments, statuses, topics } from "/catalog.mjs";
import { attachCsvPreview } from "/csv-preview.mjs";

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
  topic: "", sentiment: "", q: "", labelType: "", label: "", page: 1, report: null,
  config: { localWhisper: false, providers: [] }, model: "",
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
let sampleBusy = false;
const titleFor = { dashboard: "Přehled hovorů", calls: "Hovory", analysis: "AI analýza hovorů", import: "Import dat" };
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
  if (includeCallFilters) fields.push("topic", "sentiment", "q", "labelType", "label");
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

function renderTopicMap(report) {
  if (!report.topicMap.length) return "";
  const branch = (name, kind, entries, topic) => `<div class="topic-branch"><h3>${name}</h3>
    ${entries.length ? `<ul>${entries.map(({ label, count }) => `<li><button type="button" class="map-item"
      data-map-topic="${topic}" data-map-kind="${kind}" data-map-label="${html(label)}" aria-label="${html(label)}, zobrazit hovory">
      <span>${html(label)}</span><strong>${csNumber(count)}</strong></button></li>`).join("")}</ul>` : "<p class=\"form-hint\">Zatím bez výsledků.</p>"}
  </div>`;
  return `<section class="card panel topic-map" aria-label="Mapa důvodů volání">
    <div class="panel-head"><div><h2>Mapa důvodů volání</h2><p>Rozbalte téma nebo vyberte důvod a otevřete související hovory.</p></div>
      <button type="button" class="button button-outline" data-report-export>Export reportu</button></div>
    ${report.topicMap.map(({ id, count, share, reasons, requests }, index) => `<details class="topic-node"${index ? "" : " open"}>
      <summary>${topics[id]} <span>${csNumber(count)} · ${percent(share)}</span></summary>
      <div class="topic-branches">${branch("Problémy a důvody", "reason", reasons, id)}${branch("Požadavky zákazníků", "request", requests, id)}</div>
    </details>`).join("")}
  </section>`;
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
    dashboard.innerHTML = `<div class="card">${empty("Zatím bez importovaných hovorů", "Načtěte hovory z VoIPmonitoru nebo vložte CSV s přepisy.",
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
    ${renderTopicMap(report)}
    <section class="card table-panel" aria-label="Nedávné hovory">
      <div class="panel-head table-heading"><h2>Nedávné hovory</h2><button type="button" class="link-button" data-view="calls" data-clear-filters>Zobrazit všechny hovory</button></div>
      ${recent.length ? table(recent) : empty("V tomto období nejsou hovory", "Změňte období nebo pobočku ve filtrech.")}
    </section>`;
  if (series.length) closeChart = setupTrend(dashboard.querySelector("canvas"), series, dashboard.querySelector(".chart-tooltip"));
}

function modelChoices() {
  return state.config.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      key: `${provider.id}:${model}`, id: provider.id, model, label: provider.label, external: provider.external,
    })));
}

function modelSelector() {
  const choices = modelChoices();
  const current = choices.find((choice) => choice.key === state.model) ?? choices[0];
  if (!current) return "";
  return `<label><span class="sr-only">Model pro analýzu</span><select data-analysis-model>
    ${choices.map((choice) => `<option value="${html(choice.key)}"${choice.key === current.key ? " selected" : ""}>${html(choice.label)} · ${html(choice.model)}</option>`).join("")}
  </select></label>`;
}

function modelNotice(choice) {
  return choice?.external ? `Služba ${choice.label} dostane přepis a sloupce vybrané jako kontext.` : "";
}

function modelNoticeMarkup() {
  const choices = modelChoices();
  const notice = modelNotice(choices.find((choice) => choice.key === state.model) ?? choices[0]);
  return `<p class="form-hint" data-model-notice${notice ? "" : " hidden"}>${html(notice)}</p>`;
}

const readyCount = (report) => state.config.localWhisper ? report.queue.waiting : report.queue.waitingWithTranscript;

function renderModels(report) {
  const panel = byId("models-panel");
  if (state.dataset === "demo" || !report.latest) {
    panel.replaceChildren();
    return;
  }
  if (!modelChoices().length) {
    panel.innerHTML = '<div class="card models-panel"><div><strong>AI analýza čeká na nastavení modelu</strong><p>Poskytovatele a modely najdete v části AI analýza.</p></div><button type="button" class="button button-outline" data-view="analysis">Otevřít AI analýzu</button></div>';
    return;
  }
  const { active } = report.queue;
  const waiting = readyCount(report);
  panel.innerHTML = `<div class="card models-panel"><div><strong>AI analýza</strong>
     <p>Čeká na analýzu nebo opakování ${csNumber(waiting)} · Ve frontě a zpracování ${csNumber(active)}</p></div>
     <form id="queue-form">${modelSelector()}
       <button type="submit" class="button button-primary"${waiting ? "" : " disabled"}>Analyzovat čekající</button>
       ${modelNoticeMarkup()}
     </form></div>`;
}

function renderAnalysis(report) {
  const waiting = readyCount(report);
  const canAnalyze = modelChoices().length > 0;
  byId("analysis-content").innerHTML = `<div class="analysis-grid">
    <section class="card panel">
      <h2>Zpracování hovorů</h2>
      <div class="analysis-queue">
        <span><strong>${csNumber(waiting)}</strong> připraveno</span>
        <span><strong>${csNumber(report.queue.active)}</strong> ve frontě a zpracování</span>
        <span><strong>${csNumber(report.queue.analyzed)}</strong> analyzováno</span>
      </div>
      ${canAnalyze ? `<form id="analysis-form" class="analysis-form">${modelSelector()}${modelNoticeMarkup()}
        <div class="analysis-actions">
          <button type="submit" class="button button-primary" value="batch"${waiting ? "" : " disabled"}>Analyzovat čekající hovory</button>
          <button type="submit" class="button button-outline" value="sample"${sampleBusy ? " disabled" : ""}>Vyzkoušet na ukázce</button>
        </div>
      </form>` : '<p>Přidejte klíč nebo adresu vlastního AI serveru do konfigurace aplikace.</p>'}
      ${!state.config.localWhisper ? '<p class="form-hint">K analýze přepisů stačí zvolený model. Pro samostatné nahrávky nastavte také službu Whisper.</p>' : ""}
      <button type="button" class="link-button" data-view="dashboard">Otevřít přehled výsledků</button>
    </section>
    <section class="card panel">
      <h2>Poskytovatelé</h2>
      <ul class="provider-rows">${state.config.providers.map(({ label, models, setting }) => `<li>
        <strong>${html(label)}</strong>${models.length
          ? `<span title="Nastavené modely">${html(models.join(", "))}</span>`
          : `<code>${html(setting)}</code>`}</li>`).join("")}</ul>
    </section>
  </div>`;
}

function renderCalls(data, report) {
  const pane = byId("calls-result");
  byId("map-filter").hidden = !state.labelType;
  byId("map-filter-label").textContent = state.label;
  renderModels(report);
  if (data.total && !data.calls.length && state.page > 1) {
    state.page = 1;
    void refresh();
    return;
  }
  if (!data.calls.length) {
    pane.innerHTML = empty("Žádné hovory", report.latest ? "Změňte období nebo filtry." : "Načtěte hovory z VoIPmonitoru nebo vložte CSV s přepisy.",
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
  const pane = byId({ dashboard: "dashboard", calls: "calls-result", analysis: "analysis-content" }[state.view]);
  if (!background) pane.setAttribute("aria-busy", "true");
  try {
    const report = await api(`/api/report?${state.view === "analysis" ? "dataset=pilot" : params()}`);
    if (request !== revision) return;
    state.report = report;
    if (!background && state.view !== "analysis") updateFilters(report);
    const activeSource = sourceLabel[state.dataset];
    byId("page-note").textContent = state.view === "analysis" ? "Témata, důvody, požadavky a výsledek z přepisů"
      : report.previous && state.view === "dashboard"
        ? `${activeSource} · Srovnání s obdobím ${dateSpan(report.prior.from, report.prior.to)}`
        : activeSource;
    if (state.view === "dashboard") {
      renderDashboard(report);
    } else if (state.view === "analysis") {
      renderAnalysis(report);
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
  if (view === "analysis" && state.dataset !== "pilot") setDataset("pilot");
  revision += 1;
  clearTimeout(pollTimer);
  clearTimeout(voipTimer);
  tell();
  const heading = byId("page-title");
  heading.textContent = titleFor[view];
  byId("page-note").textContent = view === "import" ? "Hovory z VoIPmonitoru a přepisy z externích zdrojů" : sourceLabel[state.dataset];
  byId("period-filters").hidden = view === "import" || view === "analysis";
  byId("open-export").hidden = view === "import" || view === "analysis";
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
  Object.assign(state, { from: "", to: "", branch: "", topic: "", sentiment: "", q: "", labelType: "", label: "", page: 1 });
}

function renderDetail(call) {
  detailCall = call;
  const analysis = call.analysis;
  byId("detail-title").textContent = analysis?.title || `Hovor ${call.cdrId}`;
  byId("detail-meta").textContent = [call.cdrId, date(call.startedAt.slice(0, 10), longDay),
    call.startedAt.slice(11, 16), call.branch || (call.sensor ? `Sonda ${call.sensor}` : "")].filter(Boolean).join(" · ");
  const hasAnalysisInput = call.transcript?.length || (call.hasAudio && state.config.localWhisper);
  const canAnalyze = modelChoices().length > 0 && call.dataset === "pilot" && hasAnalysisInput &&
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
      <dl>${analysis.reason ? `<dt>Důvod volání</dt><dd>${html(analysis.reason)}</dd>` : ""}
      <dt>Požadavek</dt><dd>${html(analysis.request)}</dd><dt>Výsledek</dt><dd>${html(analysis.outcome)}</dd>
      <dt>Model</dt><dd>${html([state.config.providers.find((provider) => provider.id === analysis.provider)?.label, analysis.model].filter(Boolean).join(" · "))}</dd></dl>
      ${call.status === "complete" ? `<label>Opravit téma <select id="edit-topic">${options(topics, call.topic)}</select></label>` : ""}
    </section>` : ""}
    ${call.context?.length ? `<section class="detail-block"><h3>Kontext z CSV</h3>
      <dl>${call.context.map(({ label, value }) => `<dt>${html(label)}</dt><dd>${html(value)}</dd>`).join("")}</dl>
    </section>` : ""}
    <section class="detail-block"><h3>Nahrávka</h3>
      ${call.hasAudio ? `<audio id="recording" controls preload="metadata" src="/api/calls/${html(call.key)}/audio"></audio>` : "<p>Nahrávka není k dispozici.</p>"}
    </section>
    <section class="detail-block"><h3>Přepis</h3>
      ${call.transcriptSource === "csv" ? '<span class="label-pill">Importováno z CSV</span>' : ""}
      ${call.transcript?.length ? `<ol class="detail-transcript">${call.transcript.map((segment, index) => {
        const evidence = analysis?.evidence?.includes(index);
        const timed = Number.isFinite(segment.seconds);
        return `<li class="${evidence ? "evidence" : ""}${timed ? "" : " untimed"}">
          ${timed ? (call.hasAudio ? `<button type="button" class="link-button" data-seek="${segment.seconds}" aria-label="Přehrát od ${elapsed(segment.seconds)}">${elapsed(segment.seconds)}</button>` : `<span>${elapsed(segment.seconds)}</span>`) : ""}
          <div>${segment.speaker || evidence ? `<strong>${[segment.speaker, evidence ? "Podklad souhrnu" : ""].filter(Boolean).map(html).join(" · ")}</strong>` : ""}<div class="transcript-text">${html(segment.text)}</div></div></li>`;
      }).join("")}</ol>` : "<p>Přepis zatím není k dispozici.</p>"}
      ${call.error ? `<p class="notice error" role="status">${html(call.error)}</p>` : ""}
      ${canAnalyze ? `<form id="detail-queue-form" class="detail-actions">
        ${modelSelector()}
        <button class="button button-primary" type="submit">${analysis ? "Analyzovat znovu" : "Analyzovat hovor"}</button>
        ${modelNoticeMarkup()}
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

async function queueJobs(key, choice, button) {
  if (!choice) return;
  button.disabled = true;
  try {
    const { queued } = await post("/api/analyze", { ...(key ? { key } : {}), model: choice.model, provider: choice.id });
    state.model = choice.key;
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
  if (button.hasAttribute("data-report-export")) return openExport("report");
  if (button.dataset.mapTopic) {
    Object.assign(state, {
      topic: button.dataset.mapTopic, sentiment: "", q: "", labelType: button.dataset.mapKind, label: button.dataset.mapLabel, page: 1,
    });
    return showView("calls");
  }
  if (button.dataset.view) {
    if (button.hasAttribute("data-open-voip") && voipRun) {
      setDataset("pilot");
      Object.assign(state, { from: voipRun.from, to: voipRun.to });
    }
    if (button.hasAttribute("data-clear-filters")) Object.assign(state, { topic: "", sentiment: "", q: "", labelType: "", label: "" });
    if (button.dataset.view === "calls" && state.view !== "calls") state.page = 1;
    return showView(button.dataset.view);
  }
  if (button.dataset.topic) {
    Object.assign(state, { topic: button.dataset.topic, sentiment: "", q: "", labelType: "", label: "", page: 1 });
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
  showView(state.view === "import" || state.view === "analysis" && state.dataset === "demo" ? "dashboard" : state.view);
});
byId("open-import").addEventListener("click", () => showView("import"));
function openExport(format) {
  byId("export-form").elements.format.value = format;
  byId("transcript-export").hidden = format === "report";
  byId("export-description").textContent = `${sourceLabel[state.dataset]} se stáhnou podle aktuálního období a filtrů.`;
  byId("export-dialog").showModal();
}
byId("open-export").addEventListener("click", () => openExport("calls"));
byId("export-form").addEventListener("change", (event) => {
  if (event.target.name === "format") byId("transcript-export").hidden = event.target.value === "report";
});
byId("export-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const query = params(state.view === "calls");
  const form = new FormData(event.currentTarget);
  const report = form.get("format") === "report";
  if (!report && form.has("includeTranscript")) query.set("includeTranscript", "1");
  const link = document.createElement("a");
  link.href = `${report ? "/api/export/report.csv" : "/api/export.csv"}?${query}`;
  link.download = report ? "voipmonitor-report.csv" : "voipmonitor-hovory.csv";
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
byId("clear-map-filter").addEventListener("click", () => {
  Object.assign(state, { labelType: "", label: "", page: 1 });
  void refresh();
});
document.addEventListener("change", (event) => {
  if (!event.target.hasAttribute("data-analysis-model")) return;
  state.model = event.target.value;
  const note = event.target.form.querySelector("[data-model-notice]");
  const text = modelNotice(modelChoices().find((item) => item.key === state.model));
  note.textContent = text;
  note.hidden = !text;
});

async function trySample(choice, button) {
  if (sampleBusy || !choice) return;
  sampleBusy = true;
  button.disabled = true;
  const result = byId("analysis-sample");
  result.hidden = false;
  result.textContent = "Analyzuji fiktivní přepis…";
  try {
    const analysis = await post("/api/analyze/sample", { model: choice.model, provider: choice.id });
    result.innerHTML = `<h2>Výsledek ukázkové analýzy</h2><h3>${html(analysis.title)}</h3>
      <p>${html(analysis.summary)}</p><p class="form-hint">${topics[analysis.topic]} · ${html(analysis.reason)} · ${sentiments[analysis.sentiment]}</p>`;
  } catch (error) {
    result.textContent = error.message;
  } finally {
    sampleBusy = false;
    button.disabled = false;
    const current = byId("analysis-form")?.querySelector('button[value="sample"]');
    if (current) current.disabled = false;
  }
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!["queue-form", "detail-queue-form", "analysis-form"].includes(form.id)) return;
  event.preventDefault();
  const choice = modelChoices().find((item) => item.key === form.querySelector("[data-analysis-model]").value);
  const button = event.submitter ?? form.querySelector('button[type="submit"]');
  if (button.value === "sample") return void trySample(choice, button);
  if (form.id === "detail-queue-form" && !detailKey) return;
  void queueJobs(form.id === "detail-queue-form" ? detailKey : null, choice, button);
});

function renderVoipImport(data) {
  const form = byId("voip-form");
  const note = byId("api-source-note");
  const result = byId("voip-result");
  form.hidden = !data.configured;
  note.textContent = data.configError || (data.configured
    ? `Vyberte nejvýše ${data.maxDays} dnů. VoIPmonitor poskytne nahrávky ve své uložené podobě.`
    : "Připojení čeká na adresu VoIPmonitoru a místní účet s přístupem k API. Údaje se nastavují na serveru.");
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

const csvPreview = attachCsvPreview(byId("import-form"));
byId("import-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const result = byId("import-result");
  csvPreview.setSubmitting(true);
  result.classList.remove("form-error");
  result.hidden = false;
  result.textContent = "Načítám soubory…";
  const payload = new FormData(form);
  if (!payload.get("wav")?.name) payload.delete("wav");
  try {
    payload.set("mapping", JSON.stringify(csvPreview.mapping()));
    const outcome = await api("/api/import", { method: "POST", body: payload });
    const hasCalls = outcome.added + outcome.existing > 0;
    if (hasCalls) setDataset("pilot");
    result.innerHTML = `<strong>${hasCalls ? "Import dokončen" : "Import neobsahoval platné hovory"}</strong>
      <p>Nové hovory ${csNumber(outcome.added)} · Již uložené ${csNumber(outcome.existing)} · Přidáno přepisů ${csNumber(outcome.transcripts)} · S nahrávkou ${csNumber(outcome.matched)}</p>
      ${outcome.issues.length ? `<ul>${outcome.issues.map((issue) => `<li>${html(issue.row ? `Řádek CSV ${issue.row}` : issue.file)} · ${html(issue.message)}</li>`).join("")}</ul>` : ""}
      ${hasCalls ? '<button type="button" class="button button-primary" data-view="calls">Otevřít hovory</button>' : ""}`;
    if (hasCalls && !outcome.issues.length) {
      form.reset();
      csvPreview.clear();
    }
  } catch (error) {
    result.classList.add("form-error");
    result.textContent = error.message;
  } finally {
    csvPreview.setSubmitting(false);
  }
});

byId("topic-filter").insertAdjacentHTML("beforeend", options(topics));
byId("sentiment-filter").insertAdjacentHTML("beforeend", options(sentiments));
try {
  state.config = await api("/api/config");
  state.model = modelChoices()[0]?.key ?? "";
} catch (error) {
  tell(error.message, true);
}
showView("dashboard", false);
