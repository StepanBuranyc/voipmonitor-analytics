import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InputError, parseCdrCsv } from "./lib/cdr.mjs";
import { createWorker, modelConfig } from "./lib/models.mjs";
import { callRow, callsCsv, filterRows, makeReport, normalizeFilter, topicOf } from "./lib/report.mjs";
import { openStore } from "./lib/store.mjs";
import { createVoipmonitorImport, voipmonitorConfig } from "./lib/voipmonitor.mjs";
import { topics } from "./public/catalog.mjs";

const MiB = 1024 * 1024;
const maxUpload = 96 * MiB;
const maxWav = 32 * MiB;
const maxCsv = 2 * MiB;
const root = new URL("./", import.meta.url);
const staticFiles = new Map([
  ["/", ["public/index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["public/styles.css", "text/css; charset=utf-8"]],
  ["/app.mjs", ["public/app.mjs", "text/javascript; charset=utf-8"]],
  ["/chart.mjs", ["public/chart.mjs", "text/javascript; charset=utf-8"]],
  ["/catalog.mjs", ["public/catalog.mjs", "text/javascript; charset=utf-8"]],
  ["/examples/cdr.csv", ["examples/cdr.csv", "text/csv; charset=utf-8"]],
  ["/examples/VPM-1001.wav", ["examples/VPM-1001.wav", "audio/wav"]],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, type, extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...extra });
  res.end(body);
}
const json = (res, status, data) => send(res, status, JSON.stringify(data), "application/json; charset=utf-8");

async function body(req, limit) {
  if (Number(req.headers["content-length"]) > limit) throw new HttpError(413, "Soubor nebo dávka překračuje velikostní limit.");
  const parts = [];
  let size = 0;
  // Keep the socket open long enough to deliver a 413 on chunked uploads.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new HttpError(413, "Soubor nebo dávka překračuje velikostní limit.");
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts, size);
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers["content-type"] || "")) {
    throw new HttpError(415, "Požadavek musí být ve formátu JSON.");
  }
  const data = await body(req, 8_192);
  try {
    const value = JSON.parse(data.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch {
    throw new InputError("Neplatný požadavek JSON.");
  }
}

async function receiveImport(req, url, store) {
  const contentType = req.headers["content-type"] || "";
  if (!/^multipart\/form-data\s*;/i.test(contentType)) throw new HttpError(415, "Očekává se formulář s CDR a nahrávkami.");
  const bytes = await body(req, maxUpload);
  let form;
  try {
    form = await new Request(url, { method: "POST", headers: { "Content-Type": contentType }, body: bytes }).formData();
  } catch {
    throw new InputError("Nepodařilo se načíst formulář se soubory.");
  }
  const cdr = form.get("cdr");
  if (!(cdr instanceof File) || !cdr.size || !/\.csv$/i.test(cdr.name) || form.getAll("cdr").length !== 1) {
    throw new InputError("Přiložte jeden CDR CSV soubor.");
  }
  if (cdr.size > maxCsv) throw new HttpError(413, "CDR CSV může mít nejvýše 2 MiB.");
  const files = form.getAll("wav");
  if (files.length > 60) throw new InputError("Jeden import přijme nejvýše 60 nahrávek.");
  const audio = new Map();
  const duplicates = new Set();
  const fileIssues = [];
  for (const file of files) {
    if (!(file instanceof File) || !/\.wav$/i.test(file.name)) throw new InputError("Nahrávky vložte jako WAV.");
    const name = file.name.toLowerCase();
    if (duplicates.has(name)) continue;
    if (audio.has(name)) {
      audio.delete(name);
      duplicates.add(name);
      fileIssues.push({ file: name, message: "V dávce jsou dva soubory se stejným názvem." });
    } else if (file.size > maxWav) {
      fileIssues.push({ file: name, message: "Nahrávka překračuje 32 MiB." });
    } else {
      audio.set(name, Buffer.from(await file.arrayBuffer()));
    }
  }
  const { calls, issues } = parseCdrCsv(new Uint8Array(await cdr.arrayBuffer()));
  return store.importBatch(calls, audio, [...issues, ...fileIssues]);
}

function sendAudio(req, res, audio) {
  const range = req.headers.range;
  const base = { "Accept-Ranges": "bytes" };
  if (!range) return send(res, 200, audio, "audio/wav", base);
  const match = range.match(/^bytes=(\d*)-(\d*)$/);
  const start = match?.[1] ? Number(match[1]) : Math.max(0, audio.length - Number(match?.[2]));
  const end = match?.[1] && match[2] ? Math.min(audio.length - 1, Number(match[2])) : audio.length - 1;
  if (!match || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= audio.length || start > end) {
    res.writeHead(416, { ...base, "Content-Range": `bytes */${audio.length}` });
    return res.end();
  }
  return send(res, 206, audio.subarray(start, end + 1), "audio/wav", {
    ...base, "Content-Range": `bytes ${start}-${end}/${audio.length}`,
  });
}

function getPublicOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" ||
      url.username || url.password || url.search || url.hash) {
    throw new Error("VOIP_PUBLIC_ORIGIN musí obsahovat samotný původ HTTP(S), včetně případného portu.");
  }
  return url;
}

export function makeServer({
  database = process.env.VOIP_DB || fileURLToPath(new URL("data/pilot.sqlite", root)),
  env = process.env,
} = {}) {
  const publicOrigin = getPublicOrigin(env.VOIP_PUBLIC_ORIGIN);
  const config = modelConfig(env);
  const store = openStore(database);
  const worker = createWorker(store, config);
  let voip;
  let voipError;
  try {
    voip = createVoipmonitorImport(store, voipmonitorConfig(env));
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    voipError = error.message;
    voip = createVoipmonitorImport(store, null);
  }
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; " +
      "form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    try {
      const port = server.address().port;
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
      const matchesPublicOrigin = publicOrigin && req.headers.host === publicOrigin.host;
      if (!matchesPublicOrigin && !allowed.includes(req.headers.host)) {
        throw new HttpError(403, "Tato adresa neodpovídá konfiguraci aplikace.");
      }
      const origin = matchesPublicOrigin ? publicOrigin.origin : `http://${req.headers.host}`;
      const url = new URL(req.url, origin);
      if (url.origin !== origin || (req.headers.origin && req.headers.origin !== origin) ||
          req.headers["sec-fetch-site"] === "cross-site") {
        throw new HttpError(403, "Nepovolený původ požadavku.");
      }
      const path = url.pathname;
      const params = url.searchParams;
      const method = req.method;
      if (method === "GET" && staticFiles.has(path)) {
        const [file, type] = staticFiles.get(path);
        const bytes = readFileSync(new URL(file, root));
        return send(res, 200, bytes, type, path.startsWith("/examples/") ?
          { "Content-Disposition": `attachment; filename="${path.split("/").at(-1)}"` } : {});
      }
      if (method === "GET" && path === "/api/config") return json(res, 200, { localModels: worker.enabled, models: worker.models });
      if (path === "/api/voipmonitor") {
        if (method === "GET") return json(res, 200, { ...voip.status(), configError: voipError ?? null });
        if (method === "POST") {
          const payload = await readJson(req);
          if (voip.status().run?.state === "running") throw new HttpError(409, "Import z VoIPmonitoru už probíhá.");
          return json(res, 202, voip.start(payload));
        }
      }
      if (method === "POST" && path === "/api/import") return json(res, 200, await receiveImport(req, url, store));
      if (method === "POST" && path === "/api/analyze") {
        const payload = await readJson(req);
        if (!worker.enabled) throw new HttpError(409, "Nastavte lokální Whisper a Ollama podle návodu k pilotu.");
        if (!worker.models.includes(payload.model)) throw new InputError("Vyberte některý z nakonfigurovaných modelů.");
        if (payload.key !== undefined && (typeof payload.key !== "string" || !/^[0-9a-f]{32}$/.test(payload.key))) {
          throw new InputError("Neplatný identifikátor hovoru.");
        }
        const queued = store.queue(payload.model, payload.key);
        worker.run();
        return json(res, 202, { queued });
      }
      const detail = path.match(/^\/api\/calls\/([a-z0-9-]{1,40})(?:\/(audio|topic))?$/);
      if (detail) {
        const [, key, part] = detail;
        if (method === "GET" && part === "audio") {
          const audio = store.audio(key);
          if (!audio) throw new HttpError(404, "Nahrávka není k dispozici.");
          return sendAudio(req, res, audio);
        }
        const call = store.get(key);
        if (!call) throw new HttpError(404, "Hovor nebyl nalezen.");
        if (method === "GET" && !part) return json(res, 200, { ...call, topic: topicOf(call) ?? null });
        if (method === "POST" && part === "topic") {
          const payload = await readJson(req);
          if (typeof payload.topic !== "string" || !Object.hasOwn(topics, payload.topic)) throw new InputError("Vyberte platné téma.");
          if (!store.setTopic(key, payload.topic).changes) throw new HttpError(409, "Počkejte na dokončení analýzy hovoru.");
          return json(res, 200, { topic: payload.topic });
        }
      }
      if (method === "GET" && ["/api/report", "/api/calls", "/api/export.csv"].includes(path)) {
        const dataset = params.get("dataset") || "pilot";
        if (dataset !== "pilot" && dataset !== "demo") throw new InputError("Neplatný zdroj dat.");
        const filter = normalizeFilter(params);
        const data = store.list(dataset);
        if (path === "/api/report") return json(res, 200, makeReport(data, filter));
        const filtered = filterRows(data, filter);
        if (path === "/api/export.csv") {
          const csv = callsCsv(filtered, params.get("includeTranscript") === "1");
          return send(res, 200, csv, "text/csv; charset=utf-8", {
            "Content-Disposition": 'attachment; filename="voipmonitor-hovory.csv"',
          });
        }
        const page = Math.max(1, Number.parseInt(params.get("page"), 10) || 1);
        const pageSize = Math.min(100, Math.max(1, Number.parseInt(params.get("pageSize"), 10) || 25));
        const start = (page - 1) * pageSize;
        return json(res, 200, { total: filtered.length, page, pageSize, calls: filtered.slice(start, start + pageSize).map(callRow) });
      }
      throw new HttpError(404, "Stránka nebo operace nebyla nalezena.");
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
      if (error instanceof InputError) return json(res, 400, { error: error.message });
      console.error("Chyba aplikace:", error.name);
      return json(res, 500, { error: "Aplikace při zpracování požadavku narazila na chybu." });
    }
  });
  server.once("listening", worker.run);
  server.once("close", () => store.db.close());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 4196);
  const host = process.env.VOIP_LISTEN_HOST || "127.0.0.1";
  if (host !== "127.0.0.1" && !process.env.VOIP_PUBLIC_ORIGIN) {
    throw new Error("Při naslouchání mimo loopback nastavte VOIP_PUBLIC_ORIGIN.");
  }
  const server = makeServer();
  server.on("error", (error) => {
    console.error(`Server se nepodařilo spustit: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => console.log(`Přehled hovorů naslouchá na ${host}:${server.address().port}.`));
}
