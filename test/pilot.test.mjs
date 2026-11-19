import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { createServer, request as httpRequest } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { makeServer } from "../server.mjs";
import { modelConfig } from "../lib/models.mjs";
import { providerConfigs, requestAnalysis } from "../lib/providers.mjs";
import { parseCdrCsv } from "../lib/cdr.mjs";
import { readWave } from "../lib/wave.mjs";
import { readCsv, suggestCsvMapping, validateCsvMapping } from "../public/csv.mjs";

const sample = (file) => readFileSync(new URL(`../examples/${file}`, import.meta.url));
const bytes = (text) => Buffer.from(text, "utf8");

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

test("Docker deployment permits its configured origin and rejects other hosts and origins", async (t) => {
  const publicHost = "pilot.example.test:4196";
  const publicOrigin = `http://${publicHost}`;
  const app = makeServer({ database: ":memory:", env: { VOIP_PUBLIC_ORIGIN: publicOrigin } });
  const url = await listen(app);
  t.after(() => app.close());
  const status = (headers) => new Promise((resolve, reject) => {
    const request = httpRequest(url + "/api/config", { headers }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(await status({ Host: publicHost, Origin: publicOrigin }), 200);
  assert.equal(await status({ Host: publicHost, Origin: "http://other.example.test" }), 403);
  assert.equal(await status({ Host: "other.example.test" }), 403);
  assert.equal(await status({ Host: publicHost, "Sec-Fetch-Site": "cross-site" }), 403);
  assert.equal(await status({}), 200);
});

test("CDR converts Prague time and VoIPmonitor metric units", () => {
  const data = bytes("ID;calldate;mos_min_mult10;a_avgjitter_mult10;b_avgjitter_mult10;packet_loss_perc_mult1000;connect_duration;duration;branch\r\n" +
    '123;2026-10-09T23:58:00Z;43;37;41;1250;0;12;"Praha; centrum"\r\n' +
    "124;2026-02-31;43;37;41;1250;0;12;Praha\r\n");
  const { calls, issues } = parseCdrCsv(data);
  assert.equal(calls.length, 1);
  assert.equal(issues[0].row, 3);
  assert.equal(calls[0].startedAt, "2026-10-10 01:58:00");
  assert.deepEqual([calls[0].mos, calls[0].jitter, calls[0].loss, calls[0].duration], [4.3, 4.1, 1.25, 0]);
  assert.equal(calls[0].branch, "Praha; centrum");
  assert.throws(() => modelConfig({ OLLAMA_URL: "file:///etc/example" }), /HTTP/);
  assert.throws(() => modelConfig({ OLLAMA_MODELS: "model:20b-cloud" }), /cloudový model/);
  assert.equal(modelConfig({ CUSTOM_AI_URL: "https://example.test/v1/", CUSTOM_AI_MODELS: "private-model" })
    .providers.find(({ id }) => id === "custom").endpoint, "https://example.test/v1/chat/completions");
});

test("CSV preview recognizes quoted separators and applies the same index mapping as import", () => {
  const csv = bytes('"Ignorovat; toto","Interní ID","Komentář","Oddělení","Interní ID"\r\n' +
    '"zůstane venku","MAP-10","Volající uvedl\r\ntermín.","Servis","druhé ID"\r\n');
  const [headers, record] = readCsv(csv, { limit: 2 });
  assert.equal(headers[0], "Ignorovat; toto");
  assert.equal(record[2], "Volající uvedl\r\ntermín.");
  assert.deepEqual(suggestCsvMapping(["cdr_id", "cdr_started_at", "transcription", "Other"]), ["cdrid", "calldate", "transcript", ""]);
  assert.throws(() => validateCsvMapping(["cdrid", "calldate", "cdrid", "", ""], 5), /nejvýše/);
  const { calls, issues } = parseCdrCsv(csv, () => ({ startedAt: "2026-10-31", sensor: "7" }),
    ["", "cdrid", "transcript", "context", ""]);
  assert.deepEqual(issues, []);
  assert.equal(calls[0].cdrId, "MAP-10");
  assert.equal(calls[0].sensor, "7");
  assert.deepEqual(calls[0].context, [{ label: "Oddělení", value: "Servis" }]);
  assert.doesNotMatch(JSON.stringify(calls), /zůstane venku|druhé ID/);
});

test("cloud and own-service adapters use intended endpoints and structured output", async () => {
  const env = {
    OPENAI_API_KEY: "openai-fixture", GEMINI_API_KEY: "gemini-fixture", XAI_API_KEY: "xai-fixture", GROQ_API_KEY: "groq-fixture",
    CUSTOM_AI_URL: "https://models.example.test/proxy/v1", CUSTOM_AI_MODELS: "custom-fixture", CUSTOM_AI_API_KEY: "custom-key",
  };
  const urls = {
    openai: "https://api.openai.com/v1/responses",
    gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    xai: "https://api.x.ai/v1/chat/completions",
    groq: "https://api.groq.com/openai/v1/chat/completions",
    custom: "https://models.example.test/proxy/v1/chat/completions",
  };
  const schema = { type: "object", required: ["theme"], properties: { theme: { type: "string" } }, additionalProperties: false };
  const messages = [{ role: "user", content: "Fiktivní přepis" }];
  for (const provider of providerConfigs(env).filter(({ models }) => models.length)) {
    const result = await requestAnalysis(provider, provider.models[0], messages, schema, async (endpoint, options) => {
      assert.equal(endpoint, urls[provider.id]);
      assert.equal(options.headers.Authorization, `Bearer ${provider.id === "custom" ? "custom-key" : provider.id + "-fixture"}`);
      assert.equal(options.redirect, "error");
      const payload = JSON.parse(options.body);
      if (provider.id === "openai") {
        assert.equal(payload.store, false);
        assert.deepEqual(payload.input, messages);
        assert.deepEqual(payload.text.format.schema, schema);
        return Response.json({ output: [{ type: "message", content: [{ type: "output_text", text: '{"theme":"fakturace"}' }] }] });
      }
      assert.deepEqual(payload.messages, messages);
      assert.deepEqual(payload.response_format.json_schema.schema, schema);
      return Response.json({ choices: [{ message: { content: '{"theme":"fakturace"}' } }] });
    });
    assert.equal(result, '{"theme":"fakturace"}');
  }
});

test("import, audio range, local model queue, reporting and export work through HTTP", async (t) => {
  let transcriptionCount = 0;
  let analysisCount = 0;
  let mockError;
  const services = createServer(async (req, res) => {
    try {
      const parts = [];
      for await (const part of req) parts.push(part);
      const request = Buffer.concat(parts);
      if (req.url === "/inference") {
        transcriptionCount += 1;
        const form = await new Request("http://localhost/", {
          method: "POST", headers: { "Content-Type": req.headers["content-type"] }, body: request,
        }).formData();
        assert.equal(form.get("language"), "cs");
        assert.equal(form.get("response_format"), "verbose_json");
        assert.equal(readWave(new Uint8Array(await form.get("file").arrayBuffer())).rate, 16000);
        res.end(JSON.stringify({ segments: [{ start: 0.5, end: 5, text: "Na faktuře je dvojitá položka." }] }));
      } else if (req.url === "/api/chat") {
        analysisCount += 1;
        const body = JSON.parse(request.toString("utf8"));
        assert.equal(body.model, "model:local");
        assert.equal(body.format.type, "object");
        assert.match(body.messages.at(-1).content, /dvojitá položka/);
        res.end(JSON.stringify({ message: { content: JSON.stringify({
          title: "Reklamace faktury", reason: "Chybná faktura", topic: "billing", sentiment: "negative", summary: "Volající reklamuje fakturu.",
          request: "Opravit fakturu.", requestLabel: "Oprava faktury", outcome: "V hovoru neuvedeno", evidence: [0],
        }) } }));
      } else {
        res.writeHead(404).end();
      }
    } catch (error) {
      mockError = error;
      res.writeHead(500).end();
    }
  });
  const localModels = await listen(services);
  t.after(() => services.close());
  const app = makeServer({ database: ":memory:", env: {
    WHISPER_URL: localModels, OLLAMA_URL: localModels, OLLAMA_MODELS: "model:local", WHISPER_LANGUAGE: "cs",
  } });
  const url = await listen(app);
  t.after(() => app.close());

  const request = (path, options) => fetch(url + path, options);
  const json = async (path, options, status = 200) => {
    const response = await request(path, options);
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  };
  const post = (payload) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const upload = (csv, waves = []) => {
    const form = new FormData();
    form.append("cdr", new Blob([csv]), "cdr.csv");
    for (const [filename, wave] of waves) form.append("wav", new Blob([wave]), filename);
    return json("/api/import", { method: "POST", body: form });
  };
  const empty = await json("/api/report");
  assert.equal(empty.current.total, 0);
  const demo = await json("/api/report?dataset=demo");
  assert.ok(demo.current.total > 500);
  assert.equal(demo.from, "2026-10-01");
  assert.equal(demo.prior.to, "2026-09-30");
  assert.equal(demo.series.reduce((count, point) => count + point.total, 0), demo.current.total);
  assert.ok(demo.topTopics.some((topic) => typeof topic.delta === "number"));

  const cdr = sample("cdr.csv");
  const wav = sample("VPM-1001.wav");
  const initial = await upload(cdr);
  assert.deepEqual(initial, { added: 2, existing: 0, matched: 0, missing: 2, transcripts: 0, issues: [] });
  const again = await upload(cdr, [["VPM-1001.wav", wav], ["other.wav", wav]]);
  assert.deepEqual([again.added, again.existing, again.matched, again.missing], [0, 2, 1, 1]);
  assert.equal(again.issues[0].file, "other.wav");
  const duplicate = await upload(cdr, [["vpm-1001.WAV", wav]]);
  assert.deepEqual([duplicate.added, duplicate.existing, duplicate.matched], [0, 2, 1]);
  assert.deepEqual(duplicate.issues, []);

  const list = await json("/api/calls");
  const key = list.calls[0].key;
  assert.equal(list.calls[0].status, "ready");
  assert.equal(list.calls[1].status, "missing_audio");
  const partial = await request(`/api/calls/${key}/audio`, { headers: { Range: "bytes=0-43" } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("content-range"), `bytes 0-43/${wav.length}`);
  assert.deepEqual(Buffer.from(await partial.arrayBuffer()), wav.subarray(0, 44));
  assert.equal((await request("/api/calls", { headers: { Origin: "https://example.org" } })).status, 403);

  assert.deepEqual(await json("/api/analyze", post({ model: "model:local" }), 202), { queued: 1 });
  let call;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    call = await json(`/api/calls/${key}`);
    if (["complete", "error"].includes(call.status)) break;
    await sleep(50);
  }
  assert.ifError(mockError);
  assert.equal(call.status, "complete", call.error);
  assert.equal(call.transcript[0].seconds, 0.5);
  assert.deepEqual(call.analysis.evidence, [0]);
  assert.equal(transcriptionCount, 1);
  assert.equal(analysisCount, 1);
  const report = await json("/api/report");
  assert.equal(report.current.analyzed, 1);
  assert.equal(report.current.completeRate, 50);
  assert.equal(report.topTopics[0].id, "billing");
  assert.equal((await json("/api/calls?q=dvojita")).total, 1);
  await json(`/api/calls/${key}/topic`, post({ topic: "other" }));
  assert.equal((await json("/api/report")).topTopics[0].id, "other");

  const csv = await (await request("/api/export.csv?branch=Praha&includeTranscript=1")).text();
  assert.match(csv, /VPM-1001/);
  assert.match(csv, /Na faktuře je dvojitá položka/);
  assert.doesNotMatch(csv, /VPM-1002/);
});

test("external CSV transcripts can enrich a CDR or form new calls and run with Ollama alone", async (t) => {
  let analyzed = 0;
  const ollama = createServer(async (req, res) => {
    const parts = [];
    for await (const part of req) parts.push(part);
    const { messages } = JSON.parse(Buffer.concat(parts));
    const transcript = messages.at(-1).content;
    if (req.url !== "/api/chat" || !/Rozbitý modem|Zákazník potvrzuje|dvakrát stejný poplatek/.test(transcript)) {
      res.writeHead(400).end();
      return;
    }
    analyzed += 1;
    res.end(JSON.stringify({ message: { content: JSON.stringify({
      title: "Externí přepis", reason: "Nastavení modemu", topic: "setup", sentiment: "neutral", summary: "Souhrn externího přepisu.",
      request: "Nastavit modem.", requestLabel: "Změna nastavení", outcome: "Potvrzeno.", evidence: [0],
    }) } }));
  });
  const ollamaUrl = await listen(ollama);
  t.after(() => ollama.close());
  const app = makeServer({ database: ":memory:", env: { OLLAMA_URL: ollamaUrl, OLLAMA_MODELS: "text-only" } });
  const url = await listen(app);
  t.after(() => app.close());
  const get = async (path) => {
    const response = await fetch(url + path);
    assert.equal(response.status, 200);
    return response.json();
  };
  async function upload(csv, audios = [], mapping) {
    const form = new FormData();
    form.append("cdr", new Blob([csv]), "source.csv");
    if (mapping) form.set("mapping", JSON.stringify(mapping));
    for (const [name, data] of audios) form.append("wav", new Blob([data]), name);
    const response = await fetch(url + "/api/import", { method: "POST", body: form });
    const outcome = await response.json();
    assert.equal(response.status, 200, outcome.error);
    return outcome;
  }
  const config = await get("/api/config");
  assert.equal(config.localModels, true);
  assert.equal(config.localWhisper, false);
  const day = "2026-10-31";
  await upload("cdrId;calldate;id_sensor\n307;2026-10-31 11:00:00;7\n401;2026-10-31 12:00:00;7\n",
    [["401.wav", sample("VPM-1001.wav")]]);
  const csv = "call_id;cdr_started_at;transcription\n" +
    '307;;"Rozbitý modem\nČeká se na výměnu."\n' +
    'EXT-101;2026-10-31 09:00:00+00;"Zákazník potvrzuje nastavení."\n' +
    'NEZNAMY;;"Chybí datum."\n';
  const imported = await upload(csv);
  assert.deepEqual([imported.added, imported.existing, imported.transcripts], [1, 1, 2]);
  assert.match(imported.issues[0].message, /data|datum/);
  const repeat = await upload(csv);
  assert.deepEqual([repeat.added, repeat.existing, repeat.transcripts], [0, 2, 0]);
  const conflict = await upload("cdr_id;transcript\n307;Jiný přepis\n");
  assert.match(conflict.issues[0].message, /jiný přepis/);

  const { calls, total } = await get("/api/calls?q=rozbity");
  assert.equal(total, 1);
  const existing = await get(`/api/calls/${calls[0].key}`);
  assert.equal(existing.sensor, "7");
  assert.equal(existing.hasAudio, false);
  assert.equal(existing.transcriptSource, "csv");
  assert.deepEqual(existing.transcript, [{ seconds: null, end: null, text: "Rozbitý modem\nČeká se na výměnu." }]);
  assert.equal((await get("/api/calls?q=EXT-101")).calls[0].startedAt, day + " 10:00:00");
  assert.equal((await get("/api/report")).queue.waitingWithTranscript, 2);
  const run = await fetch(url + "/api/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: '{"model":"text-only"}',
  });
  assert.equal(run.status, 202);
  assert.deepEqual(await run.json(), { queued: 2 });
  let report;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    report = await get("/api/report");
    if (report.current.analyzed === 2) break;
    await sleep(30);
  }
  assert.equal(report.current.analyzed, 2);
  assert.equal(analyzed, 2);
  assert.deepEqual(report.topicMap[0].reasons, [{ label: "Nastavení modemu", count: 2 }]);
  assert.deepEqual(report.topicMap[0].requests, [{ label: "Změna nastavení", count: 2 }]);
  assert.equal((await get("/api/calls?topic=setup&labelType=reason&label=nastaveni-modemu")).total, 2);
  const summary = await (await fetch(url + "/api/export/report.csv")).text();
  assert.match(summary, /"problém";"Nastavení služby";"Nastavení modemu";"2"/);
  assert.match(summary, /"požadavek";"Nastavení služby";"Změna nastavení";"2"/);
  assert.doesNotMatch(summary, /Čeká se na výměnu/);
  const sampleRun = await fetch(url + "/api/analyze/sample", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: '{"provider":"ollama","model":"text-only"}',
  });
  assert.equal(sampleRun.status, 200);
  assert.equal((await sampleRun.json()).provider, "ollama");
  assert.equal((await get("/api/report")).current.analyzed, 2);
  const exported = await (await fetch(url + "/api/export.csv?includeTranscript=1&q=rozbity")).text();
  assert.match(exported, /Čeká se na výměnu/);

  const mapped = await upload('Moje ID;Údaj;Hlavička;Text\nMAP-11;Tým B;2026-10-31;Hovor o zboží\n',
    [], ["cdrid", "context", "calldate", "transcript"]);
  assert.equal(mapped.transcripts, 1);
  const byContext = await get("/api/calls?q=tým+b");
  assert.equal(byContext.total, 1);
  const mappedDetail = await get(`/api/calls/${byContext.calls[0].key}`);
  assert.deepEqual(mappedDetail.context, [{ label: "Údaj", value: "Tým B" }]);

  const largeCsv = "cdr_id;calldate;transcript\n" + Array.from({ length: 210 }, (_, index) =>
    `LARGE-${index};${day};${"x".repeat(10_500)}\n`).join("");
  assert.ok(Buffer.byteLength(largeCsv) > 2 * 1024 * 1024);
  const large = await upload(largeCsv);
  assert.equal(large.transcripts, 210);
});

test("VoIPmonitor import reads CDRs and QoS by date and sensor, then retries absent audio without duplicates", async (t) => {
  let audioAvailable = false;
  let audioRequests = 0;
  let refusedMetrics = false;
  let mockError;
  const wav = sample("VPM-1001.wav");
  const remote = createServer(async (req, res) => {
    try {
      const request = new URL(req.url, "http://example.test");
      assert.equal(req.method, "POST");
      assert.doesNotMatch(request.href, /SECRET|pilot-user/);
      const parts = [];
      for await (const part of req) parts.push(part);
      const body = Buffer.concat(parts).toString("utf8");
      const reply = (data) => res.end(JSON.stringify(data));
      if (request.pathname === "/monitor/php/api.php") {
        const command = Object.fromEntries(new URLSearchParams(body));
        command.params = JSON.parse(command.params);
        assert.match(req.headers["content-type"], /^application\/x-www-form-urlencoded/);
        assert.equal(command.user, "pilot-user");
        assert.equal(command.password, "SECRET");
        if (command.task === "getVoipCalls") {
          assert.equal(command.params.id_sensor, "7");
          assert.match(command.params.startTime, /^2026-10-(30|31) 00:00:00$/);
          assert.equal(command.params.startTimeTo, command.params.startTime.includes("2026-10-30") ?
            "2026-10-31 00:00:00" : "2026-11-01 00:00:00");
          if (command.params.startTime.includes("2026-10-30")) return reply({ success: true, cdr: null, total: 0 });
          return reply({ success: true, cdr: [
            { cdrId: "9007199254740993", calldate: "2026-10-31 15:42:00", id_sensor: 7,
              connect_duration: 21, caller: "private-number", callId: "private-sip-id" },
            { cdrId: 307, calldate: "2026-10-31 16:13:00", id_sensor: 7, connect_duration: 0, duration: 12 },
          ] });
        }
        assert.equal(command.task, "getVoiceRecording");
        assert.deepEqual(command.params, { cdrId: "9007199254740993", calldate: "2026-10-31" });
        audioRequests += 1;
        if (!audioAvailable) return reply({ success: false, data: "file missing" });
        res.writeHead(200, { "Content-Type": "audio/wav" });
        return res.end(wav);
      }
      assert.equal(request.pathname, "/monitor/php/model/sql.php");
      if (request.searchParams.get("module") === "bypass_login") {
        assert.deepEqual(Object.fromEntries(new URLSearchParams(body)), { user: "pilot-user", pass: "SECRET" });
        if (refusedMetrics) return res.writeHead(403).end();
        return reply({ success: true, SID: "syntheticSessionId", cookie_name: "PHPSESSID-monitor" });
      }
      assert.equal(req.headers.cookie, "PHPSESSID-monitor=syntheticSessionId");
      assert.equal(request.searchParams.get("task"), "LISTING");
      assert.equal(request.searchParams.get("fsensor_id"), "7");
      assert.equal(request.searchParams.get("limit"), "200");
      assert.equal(request.searchParams.get("start"), "0");
      assert.equal(request.searchParams.get("fdateto"), "2026-11-01T00:00:00");
      return res.end('{"success":true,"total":"1","results":[{"ID":9007199254740993,"mos_min":4.2,"jitter":7.3,"packet_loss_perc":0.25}]}');
    } catch (error) {
      mockError = error;
      res.writeHead(500).end();
    }
  });
  const remoteUrl = await listen(remote);
  t.after(() => remote.close());
  const app = makeServer({ database: ":memory:", env: {
    VOIPMONITOR_URL: remoteUrl + "/monitor/admin.php", VOIPMONITOR_USER: "pilot-user",
    VOIPMONITOR_PASSWORD: "SECRET", VOIPMONITOR_QOS: "1",
  } });
  const appUrl = await listen(app);
  t.after(() => app.close());
  const endpoint = appUrl + "/api/voipmonitor";
  const body = { from: "2026-10-30", to: "2026-10-31", sensor: "7", recordings: true };
  const post = (payload = body) => fetch(endpoint, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  const status = async () => (await fetch(endpoint)).json();
  async function complete() {
    for (let count = 0; count < 40; count += 1) {
      const { run } = await status();
      if (run?.state !== "running") return run;
      await sleep(30);
    }
    assert.fail("VoIPmonitor import did not reach a terminal state");
  }
  const initial = await status();
  assert.equal(initial.configured, true);
  assert.doesNotMatch(JSON.stringify(initial), /SECRET|pilot-user|monitor\/php/);
  const invalid = await post({ ...body, from: "2026-01-01" });
  assert.equal(invalid.status, 400);
  assert.equal((await post()).status, 202);
  const first = await complete();
  assert.ifError(mockError);
  assert.equal(first.state, "complete", first.error);
  assert.deepEqual([first.processedDays, first.added, first.withAudio, first.withoutAudio, first.issueCount], [2, 2, 0, 2, 1]);
  assert.equal(audioRequests, 1);
  audioAvailable = true;
  refusedMetrics = true;
  assert.equal((await post()).status, 202);
  const second = await complete();
  assert.ifError(mockError);
  assert.equal(second.state, "complete", second.error);
  assert.deepEqual([second.added, second.existing, second.withAudio, second.withoutAudio, second.issueCount], [0, 2, 1, 1, 1]);
  assert.equal(audioRequests, 2);
  assert.equal((await post()).status, 202);
  const third = await complete();
  assert.equal(third.state, "complete", third.error);
  assert.equal(audioRequests, 2);

  const { calls, total } = await (await fetch(appUrl + "/api/calls")).json();
  assert.equal(total, 2);
  const recorded = calls.find(({ hasAudio }) => hasAudio);
  assert.equal(recorded.cdrId, "9007199254740993");
  assert.deepEqual([recorded.sensor, recorded.duration, recorded.mos, recorded.jitter, recorded.loss], ["7", 21, 4.2, 7.3, 0.25]);
  assert.doesNotMatch(JSON.stringify(calls), /private-number|private-sip-id/);
  const savedAudio = await fetch(appUrl + `/api/calls/${recorded.key}/audio`);
  assert.deepEqual(Buffer.from(await savedAudio.arrayBuffer()), wav);
});
