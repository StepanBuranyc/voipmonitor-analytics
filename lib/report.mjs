import { InputError, encodeCsv, normalizeTime } from "./cdr.mjs";
import { sentiments, statuses, topics } from "../public/catalog.mjs";

const dayMs = 86_400_000;
const isoDay = (value) => new Date(value).toISOString().slice(0, 10);
const next = (date, days) => isoDay(Date.parse(date) + days * dayMs);
const countDays = (from, to) => (Date.parse(to) - Date.parse(from)) / dayMs + 1;
const percentage = (count, total) => total ? 100 * count / total : null;

export function normalizeFilter(params) {
  const from = params.get("from") || "";
  const to = params.get("to") || "";
  for (const day of [from, to].filter(Boolean)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new InputError("Filtr data očekává RRRR-MM-DD.");
    normalizeTime(day);
  }
  if (from && to && (to < from || countDays(from, to) > 366)) {
    throw new InputError("Zadejte platné období do 366 dnů.");
  }
  const labelType = params.get("labelType") || "";
  return {
    from, to,
    branch: params.get("branch") || "",
    topic: params.get("topic") || "",
    sentiment: params.get("sentiment") || "",
    q: (params.get("q") || "").trim().slice(0, 120),
    labelType: ["reason", "request"].includes(labelType) ? labelType : "",
    label: (params.get("label") || "").trim().slice(0, 350),
  };
}

export const topicOf = (call) => call.editedTopic || call.analysis?.topic;
const plain = (text) => String(text ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const labelKey = (value) => plain(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const reasonOf = (analysis) => analysis?.reason || analysis?.title;
const requestOf = (analysis) => analysis?.requestLabel || analysis?.request;
export function filterRows(rows, filter) {
  const search = plain(filter.q);
  const target = filter.labelType ? labelKey(filter.label) : "";
  const getLabel = filter.labelType === "request" ? requestOf : reasonOf;
  return rows.filter((call) => {
    const date = call.startedAt.slice(0, 10);
    if (filter.from && date < filter.from || filter.to && date > filter.to) return false;
    if (filter.branch && filter.branch !== call.branch) return false;
    if (filter.topic && filter.topic !== topicOf(call)) return false;
    if (filter.sentiment && filter.sentiment !== call.analysis?.sentiment) return false;
    if (target && target !== labelKey(getLabel(call.analysis))) return false;
    if (!search) return true;
    const searchable = [call.cdrId, call.branch, call.analysis?.title, call.analysis?.summary,
      call.analysis?.reason, call.analysis?.requestLabel, call.analysis?.request,
      ...(call.context ?? []).map(({ value }) => value),
      topics[topicOf(call)], ...(call.transcript ?? []).map(({ text }) => text)];
    return searchable.some((item) => plain(item).includes(search));
  });
}

export function callRow(call) {
  const { transcript, analysis, context, editedTopic, jobModel, jobProvider, error, ...metadata } = call;
  return {
    ...metadata,
    title: analysis?.title ?? null,
    topic: topicOf(call) ?? null,
    sentiment: analysis?.sentiment ?? null,
    hasTranscript: Boolean(transcript?.length),
  };
}

function metrics(calls) {
  const analyzed = calls.filter((call) => call.analysis);
  const mos = calls.flatMap((call) => call.mos === null ? [] : [call.mos]);
  const sentimentCounts = Object.fromEntries(Object.keys(sentiments).map((value) => [value, 0]));
  const topicCounts = Object.fromEntries(Object.keys(topics).map((value) => [value, 0]));
  for (const call of analyzed) {
    sentimentCounts[call.analysis?.sentiment ?? "unknown"] += 1;
    topicCounts[topicOf(call) ?? "other"] += 1;
  }
  return {
    total: calls.length,
    analyzed: analyzed.length,
    hasAudio: calls.filter((call) => call.hasAudio).length,
    completeRate: percentage(analyzed.length, calls.length),
    negativeRate: percentage(sentimentCounts.negative, analyzed.length),
    avgMos: mos.length ? mos.reduce((a, b) => a + b, 0) / mos.length : null,
    mosCount: mos.length,
    sentimentCounts,
    topicCounts,
  };
}

function previousRange(from, to) {
  const month = to.slice(0, 7);
  if (from === month + "-01" && next(to, 1).slice(0, 7) !== month) {
    const priorEnd = next(from, -1);
    return { from: priorEnd.slice(0, 7) + "-01", to: priorEnd };
  }
  return { from: next(from, -countDays(from, to)), to: next(from, -1) };
}

function groupLabels(calls, selectLabel) {
  const counts = new Map();
  for (const call of calls) {
    const label = selectLabel(call.analysis)?.trim();
    const key = labelKey(label);
    if (!key || key === "neuvedeno" || key === "v hovoru neuvedeno") continue;
    if (!counts.has(key)) counts.set(key, { label, count: 0 });
    counts.get(key).count += 1;
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "cs")).slice(0, 8);
}

export function makeReport(rows, filter) {
  const latest = rows[0]?.startedAt.slice(0, 10) ?? null;
  const earliest = rows.at(-1)?.startedAt.slice(0, 10) ?? null;
  const to = filter.to || latest || "";
  const from = filter.from || (to ? to.slice(0, 7) + "-01" : "");
  if (from && to && (to < from || countDays(from, to) > 366)) {
    throw new InputError("Zadejte platné období do 366 dnů.");
  }
  const current = filterRows(rows, { ...filter, from, to });
  const prior = from && to ? previousRange(from, to) : null;
  const comparison = prior ? filterRows(rows, { ...filter, ...prior }) : [];
  const now = metrics(current);
  const previous = comparison.length ? metrics(comparison) : null;
  const series = [];
  if (from && to) {
    const days = countDays(from, to);
    const step = days > 45 ? 7 : 1;
    for (let index = 0; index < days; index += step) {
      series.push({ from: next(from, index), to: next(from, Math.min(index + step, days) - 1), total: 0, analyzed: 0 });
    }
    for (const call of current) {
      const index = Math.floor((Date.parse(call.startedAt.slice(0, 10)) - Date.parse(from)) / dayMs / step);
      series[index].total += 1;
      if (call.analysis) series[index].analyzed += 1;
    }
  }
  const topTopics = Object.entries(now.topicCounts)
    .filter(([, count]) => count)
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => {
      const share = percentage(count, now.analyzed);
      const prevShare = previous ? percentage(previous.topicCounts[id], previous.analyzed) : null;
      return { id, count, share, delta: prevShare === null ? null : share - prevShare };
    });
  const analyzedCalls = current.filter((row) => row.analysis);
  const topicMap = topTopics.map((topic) => {
    const relevant = analyzedCalls.filter((row) => topicOf(row) === topic.id);
    return {
      ...topic,
      reasons: groupLabels(relevant, reasonOf),
      requests: groupLabels(relevant, requestOf),
    };
  });
  const waiting = rows.filter((row) => row.status === "ready" || row.status === "error");
  return {
    earliest, latest, from, to, prior, current: now, previous, topTopics, topicMap, series,
    branches: [...new Set(rows.map((row) => row.branch).filter(Boolean))].sort((a, b) => a.localeCompare(b, "cs")),
    recent: current.slice(0, 5).map(callRow),
    queue: {
      waiting: waiting.length,
      waitingWithTranscript: waiting.filter((row) => row.transcript).length,
      active: rows.filter((row) => row.status === "queued" || row.status === "processing").length,
      analyzed: rows.filter((row) => row.analysis).length,
    },
  };
}

export function reportCsv(report, filter) {
  const columns = ["skupina", "tema", "polozka", "pocet", "podil_pct", "zmena_pb", "od", "do", "pobocka"];
  const period = [report.from, report.to, filter.branch];
  const rounded = (value) => value == null ? null : Math.round(value * 100) / 100;
  const rows = [
    ["pokrytí", "", "Hovory celkem", report.current.total, null, null, ...period],
    ["pokrytí", "", "Analyzované hovory", report.current.analyzed, rounded(report.current.completeRate), null, ...period],
  ];
  for (const { id, count, share, delta, reasons, requests } of report.topicMap) {
    const theme = topics[id];
    rows.push(["téma", theme, theme, count, rounded(share), rounded(delta), ...period]);
    for (const [kind, values] of [["problém", reasons], ["požadavek", requests]]) {
      for (const point of values) {
        rows.push([kind, theme, point.label, point.count, rounded(percentage(point.count, report.current.analyzed)), null, ...period]);
      }
    }
  }
  return encodeCsv([columns, ...rows]);
}

export function callsCsv(calls, includeTranscript) {
  const header = ["cdr_id", "calldate", "pobocka", "id_sondy", "delka_s", "mos", "jitter_ms", "ztrata_pct",
    "stav", "tema", "sentiment", "nazev", "souhrn", "model", "duvod", "pozadavek", "vysledek", "poskytovatel"];
  if (includeTranscript) header.push("prepis");
  const rows = calls.map((call) => {
    const row = [
      call.cdrId, call.startedAt, call.branch, call.sensor, call.duration, call.mos, call.jitter, call.loss,
      statuses[call.status], topics[topicOf(call)], sentiments[call.analysis?.sentiment],
      call.analysis?.title, call.analysis?.summary, call.analysis?.model,
      call.analysis?.reason, call.analysis?.request, call.analysis?.outcome, call.analysis?.provider,
    ];
    if (includeTranscript) row.push(call.transcript?.map(({ text }) => text).join(" "));
    return row;
  });
  return encodeCsv([header, ...rows]);
}
