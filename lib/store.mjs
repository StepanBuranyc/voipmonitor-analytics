import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { InputError } from "./cdr.mjs";
import { demoData } from "./demo.mjs";
import { readWave } from "./wave.mjs";

const columns = `
  c.call_key AS key, c.dataset, c.cdr_id AS cdrId, c.started_at AS startedAt,
  c.sensor, c.branch, c.duration, c.mos, c.jitter, c.loss, c.status,
  c.error, c.transcript, c.analysis, c.edited_topic AS editedTopic, c.job_model AS jobModel,
  EXISTS(SELECT 1 FROM recordings WHERE call_key = c.call_key) AS hasAudio`;

function hydrate(row) {
  return {
    ...row,
    hasAudio: Boolean(row.hasAudio),
    transcript: row.transcript ? JSON.parse(row.transcript) : null,
    analysis: row.analysis ? JSON.parse(row.analysis) : null,
  };
}

export function openStore(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS calls (
      call_key TEXT PRIMARY KEY, dataset TEXT NOT NULL, cdr_id TEXT NOT NULL,
      started_at TEXT NOT NULL, sensor TEXT NOT NULL, branch TEXT NOT NULL,
      duration REAL, mos REAL, jitter REAL, loss REAL, status TEXT NOT NULL,
      transcript TEXT, analysis TEXT, edited_topic TEXT, job_model TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS calls_period ON calls(dataset, started_at);
    CREATE INDEX IF NOT EXISTS calls_queue ON calls(dataset, status);
    CREATE TABLE IF NOT EXISTS recordings (
      call_key TEXT PRIMARY KEY REFERENCES calls(call_key) ON DELETE CASCADE,
      sha256 TEXT NOT NULL, bytes BLOB NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO calls (call_key, dataset, cdr_id, started_at, sensor, branch, duration,
       mos, jitter, loss, status, transcript, analysis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const existingAudio = db.prepare("SELECT sha256 FROM recordings WHERE call_key = ?");
  const insertAudio = db.prepare("INSERT INTO recordings (call_key, sha256, bytes) VALUES (?, ?, ?)");
  const exists = db.prepare("SELECT status FROM calls WHERE call_key = ?");
  const fillMetrics = db.prepare(`UPDATE calls SET
      mos = COALESCE(mos, ?), jitter = COALESCE(jitter, ?), loss = COALESCE(loss, ?)
    WHERE call_key = ?`);
  const markReady = db.prepare("UPDATE calls SET status = 'ready' WHERE call_key = ? AND status = 'missing_audio'");
  const put = (call, dataset) => insert.run(
    call.key, dataset, call.cdrId, call.startedAt, call.sensor, call.branch, call.duration,
    call.mos, call.jitter, call.loss, call.status,
    call.transcript ? JSON.stringify(call.transcript) : null,
    call.analysis ? JSON.stringify(call.analysis) : null,
  );
  const transaction = (write) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  transaction(() => {
    if (!exists.get("demo-1001")) {
      const { records, sample } = demoData();
      for (const call of records) put(call, "demo");
      insertAudio.run(records[0].key, createHash("sha256").update(sample).digest("hex"), sample);
    }
  });

  return {
    db,
    list(dataset) {
      return db.prepare(`SELECT ${columns} FROM calls c WHERE c.dataset = ?
        ORDER BY c.started_at DESC, c.cdr_id DESC`).all(dataset).map(hydrate);
    },
    get(key) {
      const row = db.prepare(`SELECT ${columns} FROM calls c WHERE c.call_key = ?`).get(key);
      return row ? hydrate(row) : null;
    },
    audio(key) {
      const bytes = db.prepare("SELECT bytes FROM recordings WHERE call_key = ?").get(key)?.bytes;
      return bytes ? Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) : null;
    },
    hasAudio(key) {
      return Boolean(existingAudio.get(key));
    },
    importBatch(calls, audio, issues, { refreshMissingMetrics = false } = {}) {
      const used = new Set();
      const multiple = new Set();
      const names = new Set();
      for (const call of calls) {
        if (names.has(call.audioName)) multiple.add(call.audioName);
        names.add(call.audioName);
      }
      return transaction(() => {
        const result = { added: 0, existing: 0, matched: 0, missing: 0, issues: [...issues] };
        for (const call of calls) {
          const current = exists.get(call.key);
          const stored = current ? existingAudio.get(call.key) : null;
          const supplied = audio.get(call.audioName);
          let bytes = null;
          let digest;
          if (supplied) {
            used.add(call.audioName);
            let errorMessage;
            if (multiple.has(call.audioName)) {
              errorMessage = "Jeden WAV je přiřazený více hovorům. Uveďte pro každý hovor jiný audio_file.";
            } else {
              try {
                readWave(supplied);
                digest = createHash("sha256").update(supplied).digest("hex");
                if (stored && stored.sha256 !== digest) {
                  throw new InputError("Pod tímto ID už je uložena jiná nahrávka.");
                }
                bytes = supplied;
              } catch (error) {
                if (!(error instanceof InputError)) throw error;
                errorMessage = error.message;
              }
            }
            if (errorMessage) result.issues.push({ row: call.row, message: errorMessage });
          }
          if (current) {
            result.existing += 1;
            if (refreshMissingMetrics) fillMetrics.run(call.mos, call.jitter, call.loss, call.key);
          } else {
            put({ ...call, status: bytes ? "ready" : "missing_audio" }, "pilot");
            result.added += 1;
          }
          if (bytes && !stored) {
            insertAudio.run(call.key, digest, bytes);
            markReady.run(call.key);
          }
          if (stored || bytes) result.matched += 1;
          else result.missing += 1;
        }
        for (const name of audio.keys()) {
          if (!used.has(name)) result.issues.push({ file: name, message: "V CSV se nenašel odpovídající CDR." });
        }
        return result;
      });
    },
    setTopic(key, topic) {
      return db.prepare("UPDATE calls SET edited_topic = ? WHERE call_key = ? AND status = 'complete'").run(topic, key);
    },
    recoverJobs() {
      db.exec("UPDATE calls SET status = 'queued' WHERE dataset = 'pilot' AND status = 'processing'");
    },
    queue(model, key = null) {
      if (key) {
        return db.prepare(`UPDATE calls SET status = 'queued', job_model = ?, error = NULL
          WHERE dataset = 'pilot' AND call_key = ? AND status IN ('ready', 'error', 'complete')
          AND EXISTS(SELECT 1 FROM recordings WHERE call_key = ?)`).run(model, key, key).changes;
      }
      return db.prepare(`UPDATE calls SET status = 'queued', job_model = ?, error = NULL
        WHERE dataset = 'pilot' AND status IN ('ready', 'error')`).run(model).changes;
    },
    claim() {
      const next = db.prepare(`
        UPDATE calls SET status = 'processing' WHERE call_key = (
          SELECT call_key FROM calls WHERE dataset = 'pilot' AND status = 'queued' ORDER BY started_at LIMIT 1
        ) RETURNING call_key AS key`).get();
      return next ? this.get(next.key) : null;
    },
    saveTranscript(key, segments) {
      db.prepare("UPDATE calls SET transcript = ? WHERE call_key = ?").run(JSON.stringify(segments), key);
    },
    saveAnalysis(key, analysis) {
      db.prepare("UPDATE calls SET analysis = ?, status = 'complete', error = NULL WHERE call_key = ?").run(JSON.stringify(analysis), key);
    },
    fail(key, message) {
      db.prepare("UPDATE calls SET status = 'error', error = ? WHERE call_key = ?").run(message, key);
    },
  };
}
