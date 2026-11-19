import { createHash } from "node:crypto";

export class InputError extends Error {}

const idFields = ["cdrid", "cdr_id", "call_id", "callid", "id_hovoru", "id"];
const dateFields = ["calldate", "started_at", "cdr_started_at", "call_date", "timestamp", "date", "datum_hovoru", "datum"];
const sensorFields = ["id_sensor", "sensor_id", "id_sondy"];
const transcriptFields = ["transcript", "transcription", "transcript_text", "prepis", "přepis", "text"];

const timeZone = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Prague",
  dateStyle: "short",
  timeStyle: "medium",
});

export function normalizeTime(input) {
  const match = input.trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i);
  if (!match) throw new InputError("Datum hovoru musí být ve formátu RRRR-MM-DD HH:MM:SS nebo ISO 8601.");
  const [, day, clock = "00:00", seconds = "00", offset] = match;
  const standard = `${day}T${clock}:${seconds}`;
  const calendar = new Date(`${standard}Z`);
  if (!Number.isFinite(+calendar) || calendar.toISOString().slice(0, 19) !== standard) {
    throw new InputError("Datum nebo čas hovoru je neplatný.");
  }
  if (!offset) return standard.replace("T", " ");
  const zone = offset.length === 3 ? offset + "00" : offset.toUpperCase();
  const absolute = new Date(standard + zone);
  if (!Number.isFinite(+absolute)) throw new InputError("Časový posun hovoru je neplatný.");
  return timeZone.format(absolute);
}

function csvRows(source) {
  const delimiter = [";", ",", "\t"].find((candidate) => source.split(/\r?\n/, 1)[0].includes(candidate));
  if (!delimiter) throw new InputError("V záhlaví CDR CSV chybí oddělovač.");

  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;
  let closedQuote = false;
  const endCell = () => {
    row.push(value);
    value = "";
    closedQuote = false;
  };
  for (let i = 0; i <= source.length; i += 1) {
    const character = source[i];
    if (quoted) {
      if (character === undefined) throw new InputError("CSV obsahuje neuzavřené uvozovky.");
      if (character === '"' && source[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (character === '"') {
        quoted = false;
        closedQuote = true;
      } else {
        value += character;
      }
      continue;
    }
    if (character === delimiter) {
      endCell();
    } else if (character === undefined || character === "\n" || character === "\r") {
      endCell();
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      if (character === "\r" && source[i + 1] === "\n") i += 1;
    } else if (character === '"' && !value && !closedQuote) {
      quoted = true;
    } else if (closedQuote || character === '"') {
      throw new InputError("CSV obsahuje neplatně použité uvozovky.");
    } else {
      value += character;
    }
  }
  return rows;
}

function number(value, label, max) {
  if (!value) return null;
  const normalized = value.replace(",", ".");
  const parsed = Number(normalized);
  if (!/^\d+(?:\.\d+)?$/.test(normalized) || !Number.isFinite(parsed) || parsed > max) {
    throw new InputError(`Neplatná hodnota ve sloupci ${label}.`);
  }
  return parsed;
}

export function normalizeCdr(get, row) {
  const cdrId = get(...idFields);
  const sensor = get(...sensorFields);
  const branch = get("branch", "site", "pobocka");
  const audioName = get("audio_file") || `${cdrId}.wav`;
  if (!/^[\p{L}\p{N}_-][\p{L}\p{N}_.-]{0,95}$/u.test(cdrId)) {
    throw new InputError("ID hovoru smí obsahovat písmena, čísla, tečku, pomlčku a podtržítko.");
  }
  if (!/^[\p{L}\p{N}_. -]{1,120}\.wav$/iu.test(audioName)) {
    throw new InputError("audio_file musí obsahovat prostý název WAV souboru.");
  }
  if (sensor.length > 80 || branch.length > 80) throw new InputError("Pobočka a ID sondy mohou mít nejvýše 80 znaků.");
  const jitterDirect = number(get("jitter_ms", "jitter"), "jitter_ms", 10_000);
  const jitterA = jitterDirect === null ? number(get("a_avgjitter_mult10"), "a_avgjitter_mult10", 100_000) : null;
  const jitterB = jitterDirect === null ? number(get("b_avgjitter_mult10"), "b_avgjitter_mult10", 100_000) : null;
  const jitter = jitterA === null && jitterB === null ? null : Math.max(jitterA ?? 0, jitterB ?? 0) / 10;
  const mos = number(get("mos", "mos_min"), "mos", 5);
  const mosScaled = mos === null ? number(get("mos_min_mult10"), "mos_min_mult10", 50) : null;
  const loss = number(get("packet_loss_pct", "packet_loss_perc", "ztrata_pct"), "packet_loss_pct", 100);
  const lossScaled = loss === null ? number(get("packet_loss_perc_mult1000"), "packet_loss_perc_mult1000", 100_000) : null;
  return {
    key: createHash("sha256").update(JSON.stringify([sensor, cdrId])).digest("hex").slice(0, 32),
    cdrId,
    sensor,
    audioName: audioName.toLowerCase(),
    startedAt: normalizeTime(get(...dateFields)),
    branch,
    duration: number(get("connect_duration", "duration", "delka_s"), "duration", 86_400),
    mos: mos ?? (mosScaled === null ? null : mosScaled / 10),
    jitter: jitterDirect ?? jitter,
    loss: loss ?? (lossScaled === null ? null : lossScaled / 1_000),
    row,
  };
}

export function parseCdrCsv(bytes, findCall) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new InputError("Uložte CDR CSV v kódování UTF-8.");
  }
  const [header, ...rows] = csvRows(source.trimStart());
  if (!rows.length) throw new InputError("CDR CSV neobsahuje žádné hovory.");
  if (rows.length > 50_000) throw new InputError("Jeden import může obsahovat nejvýše 50 000 řádků.");
  const columns = header.map((field) => field.trim().toLowerCase());
  if (new Set(columns).size !== columns.length) throw new InputError("Názvy sloupců CSV musí být jedinečné.");
  const hasColumn = (fields) => fields.some((field) => columns.includes(field));
  if (!hasColumn(idFields) || !(hasColumn(dateFields) || hasColumn(transcriptFields))) {
    throw new InputError("CSV musí obsahovat ID hovoru a sloupec s datem nebo přepisem.");
  }
  const calls = [];
  const issues = [];
  const seen = new Map();
  for (const [index, row] of rows.entries()) {
    try {
      if (row.length !== columns.length) throw new InputError("Počet polí neodpovídá záhlaví.");
      const values = new Map(columns.map((column, position) => [column, row[position].trim()]));
      const get = (...fields) => fields.map((field) => values.get(field)).find(Boolean) ?? "";
      const text = get(...transcriptFields);
      const existing = text ? findCall?.(get(...idFields), get(...sensorFields)) : null;
      if (existing) {
        values.set("calldate", existing.startedAt);
        values.set("id_sensor", existing.sensor);
      }
      if (!get(...dateFields)) {
        throw new InputError("U nového hovoru uveďte datum a čas. Doplnění přepisu podle ID vyžaduje existující hovor.");
      }
      const call = normalizeCdr(get, index + 2);
      if (text) {
        call.transcript = [{ seconds: null, end: null, text }];
        call.transcriptSource = "csv";
      }
      if (seen.has(call.key)) {
        seen.get(call.key).duplicate = true;
        throw new InputError("Kombinace sondy a ID hovoru je v CSV vícekrát.");
      }
      seen.set(call.key, call);
      calls.push(call);
    } catch (error) {
      if (!(error instanceof InputError)) throw error;
      issues.push({ row: index + 2, message: error.message });
    }
  }
  for (const call of calls.filter((item) => item.duplicate)) {
    issues.push({ row: call.row, message: "Kombinace sondy a ID hovoru je v CSV vícekrát." });
  }
  return { calls: calls.filter((call) => !call.duplicate), issues };
}

export function encodeCsv(rows) {
  const separator = ";";
  const cell = (input) => {
    let value = String(input ?? "");
    if (typeof input === "string" && /^\s*[=+\-@]|^[\t\r\n]/u.test(value)) value = "'" + value;
    return '"' + value.replaceAll('"', '""') + '"';
  };
  return "\uFEFF" + rows.map((row) => row.map(cell).join(separator)).join("\r\n") + "\r\n";
}
