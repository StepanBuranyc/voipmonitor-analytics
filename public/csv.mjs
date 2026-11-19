export class CsvError extends Error {}

export const csvFields = [
  { key: "cdrid", label: "ID hovoru", aliases: ["cdr_id", "call_id", "callid", "id_hovoru", "id"] },
  { key: "calldate", label: "Začátek hovoru", aliases: ["started_at", "cdr_started_at", "call_date", "timestamp", "date", "datum_hovoru", "datum", "time-start"] },
  { key: "transcript", label: "Přepis hovoru", aliases: ["transcription", "transcript_text", "prepis", "přepis", "text"] },
  { key: "id_sensor", label: "ID sondy", aliases: ["sensor_id", "id_sondy"] },
  { key: "branch", label: "Pobočka", aliases: ["site", "pobocka", "pobočka"] },
  { key: "connect_duration", label: "Délka spojení v sekundách", aliases: [] },
  { key: "duration", label: "Délka hovoru v sekundách", aliases: ["duration_seconds", "delka_s"] },
  { key: "audio_file", label: "Název souboru WAV", aliases: [] },
  { key: "mos", label: "MOS", aliases: ["mos_min"] },
  { key: "jitter_ms", label: "Jitter v ms", aliases: ["jitter"] },
  { key: "packet_loss_pct", label: "Ztráta paketů v %", aliases: ["packet_loss_perc", "ztrata_pct"] },
  { key: "mos_min_mult10", label: "MOS × 10 z VoIPmonitoru", aliases: [] },
  { key: "a_avgjitter_mult10", label: "Jitter A × 10 z VoIPmonitoru", aliases: [] },
  { key: "b_avgjitter_mult10", label: "Jitter B × 10 z VoIPmonitoru", aliases: [] },
  { key: "packet_loss_perc_mult1000", label: "Ztráta × 1000 z VoIPmonitoru", aliases: [] },
];

export const normalizedHeader = (value) => value.trim().normalize("NFC").toLowerCase();
const validFields = new Set(csvFields.map(({ key }) => key));

export function suggestCsvMapping(headers) {
  const normalized = headers.map(normalizedHeader);
  const mapping = headers.map(() => "");
  for (const { key, aliases } of csvFields) {
    const labels = [key, ...aliases];
    const index = labels.map((label) => normalized.indexOf(label)).find((column) => column >= 0 && !mapping[column]);
    if (index !== undefined) mapping[index] = key;
  }
  return mapping;
}

export function validateCsvMapping(mapping, columns) {
  if (!Array.isArray(mapping) || mapping.length !== columns ||
      mapping.some((key) => key !== "" && key !== "context" && !validFields.has(key))) {
    throw new CsvError("Mapování neodpovídá vybranému CSV. Načtěte náhled znovu.");
  }
  const fields = mapping.filter((key) => key && key !== "context");
  if (new Set(fields).size !== fields.length) throw new CsvError("Každé pole přiřaďte nejvýše jednomu sloupci.");
  if (!fields.includes("cdrid")) throw new CsvError("Vyberte sloupec pro ID hovoru.");
  if (!fields.includes("calldate") && !fields.includes("transcript")) {
    throw new CsvError("Vyberte datum hovoru nebo přepis existujícího hovoru.");
  }
  return mapping;
}

function delimiterOf(source) {
  const counts = new Map([[";", 0], [",", 0], ["\t", 0]]);
  let quoted = false;
  for (const character of source) {
    if (character === '"') quoted = !quoted;
    if (quoted) continue;
    if (character === "\r" || character === "\n") break;
    if (counts.has(character)) counts.set(character, counts.get(character) + 1);
  }
  const [delimiter, count] = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!count) throw new CsvError("V záhlaví CSV chybí podporovaný oddělovač.");
  return delimiter;
}

export function readCsv(bytes, { limit = Infinity, partial = false } = {}) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: partial });
  } catch {
    throw new CsvError("Uložte CSV v kódování UTF-8.");
  }
  source = source.replace(/^(?:[ \t]*\r?\n)+/, "");
  const delimiter = delimiterOf(source);
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
  for (let index = 0; index <= source.length; index += 1) {
    const character = source[index];
    if (character === undefined && partial) break;
    if (quoted) {
      if (character === undefined) throw new CsvError("CSV obsahuje neuzavřené uvozovky.");
      if (character === '"' && source[index + 1] === '"') {
        value += '"';
        index += 1;
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
      if (rows.length >= limit) break;
      row = [];
      if (character === "\r" && source[index + 1] === "\n") index += 1;
    } else if (character === '"' && !value && !closedQuote) {
      quoted = true;
    } else if (closedQuote || character === '"') {
      throw new CsvError("CSV obsahuje neplatně použité uvozovky.");
    } else {
      value += character;
    }
  }
  return rows;
}
