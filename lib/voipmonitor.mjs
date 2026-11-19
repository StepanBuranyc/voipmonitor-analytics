import { InputError, normalizeCdr } from "./cdr.mjs";
import { normalizeFilter } from "./report.mjs";
import { readWave } from "./wave.mjs";

const miB = 1024 * 1024;
const dayMs = 86_400_000;
const maxDays = 31;
const pageSize = 200;
const idPattern = /^\d{1,24}$/;

export function voipmonitorConfig(env) {
  const { VOIPMONITOR_URL, VOIPMONITOR_USER, VOIPMONITOR_PASSWORD, VOIPMONITOR_QOS } = env;
  if (!VOIPMONITOR_URL && !VOIPMONITOR_USER && !VOIPMONITOR_PASSWORD) return null;
  const missing = ["VOIPMONITOR_URL", "VOIPMONITOR_USER", "VOIPMONITOR_PASSWORD"].filter((key) => !env[key]);
  if (missing.length) throw new InputError(`Pro připojení doplňte ${missing.join(", ")}.`);
  let url;
  try {
    url = new URL(VOIPMONITOR_URL);
  } catch {
    throw new InputError("VOIPMONITOR_URL musí být platná adresa VoIPmonitor GUI.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new InputError("VOIPMONITOR_URL musí být adresa HTTP(S) bez přihlašovacích údajů a parametrů.");
  }
  const guiPath = url.pathname.replace(/\/+$/, "").replace(/\/(?:php\/api\.php|admin\.php|index\.php)$/i, "");
  url.pathname = guiPath + "/php/api.php";
  const sql = new URL(url);
  sql.pathname = guiPath + "/php/model/sql.php";
  return { url, sql, user: VOIPMONITOR_USER, password: VOIPMONITOR_PASSWORD, qos: VOIPMONITOR_QOS === "1" };
}

function qualifiedDays(payload) {
  if (typeof payload.from !== "string" || typeof payload.to !== "string" || !payload.from || !payload.to) {
    throw new InputError("Zadejte začátek a konec období.");
  }
  const { from, to } = normalizeFilter(new URLSearchParams({ from: payload.from, to: payload.to }));
  const days = (Date.parse(to) - Date.parse(from)) / dayMs + 1;
  if (days > maxDays) throw new InputError(`Jedna dávka z VoIPmonitoru může mít nejvýše ${maxDays} dnů.`);
  const sensor = payload.sensor ?? "";
  if (typeof sensor !== "string" || (sensor && !/^\d{1,10}$/.test(sensor))) throw new InputError("ID sondy musí být číslo.");
  if (payload.recordings !== undefined && typeof payload.recordings !== "boolean") {
    throw new InputError("Neplatná volba stáhnout nahrávky.");
  }
  return { from, to, days, sensor, recordings: payload.recordings !== false };
}

class RemoteError extends Error {}

async function fetchBytes(url, options, { label, limit, timeout }) {
  try {
    const response = await fetch(url, { ...options, method: "POST", redirect: "error", signal: AbortSignal.timeout(timeout) });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new RemoteError(`${label} zamítl přístup. Zkontrolujte účet a jeho oprávnění.`);
      }
      throw new RemoteError(`${label} vrátil HTTP ${response.status}.`);
    }
    if (Number(response.headers.get("content-length")) > limit) {
      await response.body?.cancel();
      throw new RemoteError(`Odpověď úlohy ${label} překročila velikostní limit.`);
    }
    const parts = [];
    let size = 0;
    for await (const bytes of response.body) {
      size += bytes.byteLength;
      if (size > limit) throw new RemoteError(`Odpověď úlohy ${label} překročila velikostní limit.`);
      parts.push(bytes);
    }
    return Buffer.concat(parts, size);
  } catch (error) {
    if (error instanceof RemoteError) throw error;
    throw new RemoteError(`Úloha ${label} není dostupná, vypršel její čas nebo API přesměrovalo požadavek.`);
  }
}

function decodeJson(buffer, label) {
  try {
    return JSON.parse(buffer.toString("utf8"), (key, value, context) =>
      /^(cdrId|cdr_id|id)$/i.test(key) && typeof value === "number" ? context.source : value);
  } catch {
    throw new RemoteError(`${label} nevrátil platný JSON. Ověřte adresu GUI a oprávnění účtu.`);
  }
}

function failed(result) {
  return !result || [false, 0, "false", "0"].includes(result.success) || Boolean(result.error);
}

async function task(config, name, params, options) {
  return fetchBytes(config.url, {
    headers: { Accept: options.accept },
    body: new URLSearchParams({
      task: name, user: config.user, password: config.password, params: JSON.stringify(params),
    }),
  }, { ...options, label: name });
}

function lookup(object) {
  const fields = new Map(Object.entries(object ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  return (...keys) => {
    for (const key of keys) {
      const value = fields.get(key);
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
    return "";
  };
}

async function listCdr(config, startTime, startTimeTo, sensor) {
  const params = { startTime, startTimeTo, ...(sensor ? { id_sensor: sensor } : {}) };
  const data = decodeJson(await task(config, "getVoipCalls", params, {
    accept: "application/json", limit: 16 * miB, timeout: 60_000,
  }), "getVoipCalls");
  if (failed(data)) throw new RemoteError("VoIPmonitor odmítl načíst CDR. Ověřte údaje lokálního účtu v GUI.");
  const records = Array.isArray(data) ? data : data.cdr;
  const rows = Array.isArray(records) ? records : records && typeof records === "object" ? [records] :
    records === null || (data.success === true && Number(data.total) === 0) ? [] : null;
  if (!rows) throw new RemoteError("Ve výstupu getVoipCalls chybí seznam CDR.");
  if (data.truncated === true || Number(data.total) > rows.length) {
    throw new RemoteError("VoIPmonitor vrátil neúplný denní seznam CDR. Zkuste omezit import na jednu sondu.");
  }
  return rows;
}

async function metricsSession(config) {
  const login = new URL(config.sql);
  login.searchParams.set("module", "bypass_login");
  const result = decodeJson(await fetchBytes(login, {
    body: new URLSearchParams({ user: config.user, pass: config.password }),
  }, { label: "přihlášení k CDR API", limit: miB, timeout: 30_000 }), "Přihlášení k CDR API");
  if (failed(result) || !/^PHPSESSID(?:[-_a-zA-Z0-9]*)$/.test(result.cookie_name ?? "") ||
      typeof result.SID !== "string" || !/^[a-zA-Z0-9,-]{1,200}$/.test(result.SID)) {
    throw new RemoteError("CDR API neposkytlo platnou relaci. Ověřte oprávnění místního účtu.");
  }
  return `${result.cookie_name}=${result.SID}`;
}

async function readMetrics(config, cookie, start, end, sensor, wanted) {
  const metrics = new Map();
  if (!wanted.size) return metrics;
  let offset = 0;
  for (;;) {
    const listing = new URL(config.sql);
    listing.search = new URLSearchParams({
      task: "LISTING", module: "CDR", fdatefrom: start.replace(" ", "T"), fdateto: end.replace(" ", "T"),
      start: String(offset), limit: String(pageSize), page: String(Math.floor(offset / pageSize) + 1),
      sort: JSON.stringify([{ property: "calldate", direction: "ASC" }, { property: "ID", direction: "ASC" }]),
      ...(sensor ? { fsensor_id: sensor } : {}),
    }).toString();
    const result = decodeJson(await fetchBytes(listing, {
      headers: { Cookie: cookie },
    }, { label: "výpis CDR API", limit: 16 * miB, timeout: 60_000 }), "Výpis CDR API");
    if (failed(result) || !(Array.isArray(result.results) || Number(result.total) === 0 && result.results == null)) {
      throw new RemoteError("Rozšířené CDR API nevrátilo očekávaný výpis.");
    }
    const rows = result.results ?? [];
    for (const row of rows) {
      const get = lookup(row);
      const id = get("cdrid", "cdr_id", "id");
      if (wanted.has(id)) {
        metrics.set(id, {
          mos: get("mos_min", "mos"), jitter_ms: get("jitter", "jitter_ms"),
          packet_loss_pct: get("packet_loss_perc", "packet_loss_pct"),
        });
      }
    }
    offset += rows.length;
    if (!rows.length || offset >= Number(result.total) || metrics.size === wanted.size || rows.length < pageSize && result.total == null) break;
    if (offset >= 50_000) throw new RemoteError("Výpis metrik překročil 50 000 CDR za den. Omezte import na jednu sondu.");
  }
  return metrics;
}

export function createVoipmonitorImport(store, config) {
  let run = null;
  const recordIssue = (target, issue) => {
    target.issueCount += 1;
    if (target.issues.length < 20) target.issues.push(issue);
  };
  const process = async (job) => {
    let session = null;
    let tryMetrics = config.qos;
    for (let index = 0; index < job.days; index += 1) {
      const day = new Date(Date.parse(job.from) + index * dayMs).toISOString().slice(0, 10);
      job.day = day;
      const start = day + " 00:00:00";
      const nextDay = new Date(Date.parse(day) + dayMs).toISOString().slice(0, 10);
      const end = nextDay + " 00:00:00";
      const records = await listCdr(config, start, end, job.sensor);
      const rows = records.map(lookup);
      let metrics = new Map();
      if (tryMetrics && rows.length) {
        try {
          session ??= await metricsSession(config);
          metrics = await readMetrics(config, session, start, end, job.sensor,
            new Set(rows.map((get) => get("cdrid", "cdr_id", "id")).filter((id) => idPattern.test(id))));
        } catch (error) {
          if (!(error instanceof RemoteError)) throw error;
          recordIssue(job, { day, message: error.message });
          tryMetrics = false;
        }
      }
      const calls = new Map();
      const speech = new Set();
      for (const get of rows) {
        const cdrId = get("cdrid", "cdr_id", "id");
        const connected = get("connect_duration");
        try {
          if (!idPattern.test(cdrId)) throw new InputError("API neposkytlo platné číselné ID hovoru.");
          const extra = lookup(metrics.get(cdrId));
          const preferred = (...keys) => get(...keys) || extra(...keys);
          const call = normalizeCdr((...keys) => {
            if (keys[0] === "cdrid") return cdrId;
            if (keys[0] === "audio_file") return "";
            if (keys[0] === "id_sensor") return get(...keys) || job.sensor;
            return preferred(...keys);
          });
          if (get("calldate", "started_at").slice(0, 10) !== day) continue;
          if (!calls.has(call.key)) calls.set(call.key, call);
          if (!connected || Number(connected.replace(",", ".")) > 0) speech.add(call.key);
        } catch (error) {
          if (!(error instanceof InputError)) throw error;
          recordIssue(job, { day, cdrId: idPattern.test(cdrId) ? cdrId : undefined, message: error.message });
        }
      }
      const all = [...calls.values()];
      const stored = store.importBatch(all, new Map(), [], { refreshMissingMetrics: true });
      job.added += stored.added;
      job.existing += stored.existing;
      job.withAudio += stored.matched;
      job.withoutAudio += stored.missing;
      for (const call of all) {
        if (!job.recordings || !speech.has(call.key) || store.hasAudio(call.key)) continue;
        let audio;
        try {
          audio = await task(config, "getVoiceRecording", { cdrId: call.cdrId, calldate: day }, {
            accept: "audio/wav, application/octet-stream", limit: 32 * miB, timeout: 120_000,
          });
          readWave(audio);
        } catch (error) {
          if (!(error instanceof RemoteError || error instanceof InputError)) throw error;
          const message = error instanceof RemoteError ? error.message : "VoIPmonitor nevrátil dostupný WAV v podporovaném formátu.";
          recordIssue(job, { day, cdrId: call.cdrId, message });
          continue;
        }
        const attached = store.importBatch([call], new Map([[call.audioName, audio]]), []);
        for (const issue of attached.issues) recordIssue(job, { day, cdrId: call.cdrId, message: issue.message });
        if (attached.matched) {
          job.withAudio += 1;
          job.withoutAudio -= 1;
        }
      }
      job.processedDays += 1;
    }
  };
  return {
    status() {
      return { configured: Boolean(config), metrics: Boolean(config?.qos), maxDays, run };
    },
    start(payload) {
      if (!config) throw new InputError("Připojení k VoIPmonitoru zatím není nastavené.");
      const request = qualifiedDays(payload);
      if (run?.state === "running") throw new InputError("Počkejte na dokončení probíhajícího importu.");
      const job = {
        ...request, state: "running", day: null, processedDays: 0, added: 0, existing: 0,
        withAudio: 0, withoutAudio: 0, issueCount: 0, issues: [], error: null,
      };
      run = job;
      void process(job).then(() => {
        job.state = "complete";
      }).catch((error) => {
        job.state = "error";
        job.error = error instanceof RemoteError ? error.message : "Import z VoIPmonitoru se nepodařilo dokončit.";
        if (!(error instanceof RemoteError)) console.error("Chyba VoIPmonitor importu:", error.name);
      });
      return this.status();
    },
  };
}
