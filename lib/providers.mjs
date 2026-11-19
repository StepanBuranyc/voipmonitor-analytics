import { InputError } from "./cdr.mjs";

const cloudProviders = [
  { id: "openai", label: "OpenAI", env: "OPENAI", model: "gpt-4.1-mini", kind: "responses", url: "https://api.openai.com/v1/responses" },
  { id: "gemini", label: "Google Gemini", env: "GEMINI", model: "gemini-4-hydrogen", kind: "chat", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" },
  { id: "xai", label: "xAI Grok", env: "XAI", model: "grok-4.7", kind: "chat", url: "https://api.x.ai/v1/chat/completions" },
  { id: "groq", label: "Groq", env: "GROQ", model: "openai/gpt-oss-20b", kind: "chat", url: "https://api.groq.com/openai/v1/chat/completions" },
];

export function serviceEndpoint(value, suffix) {
  if (!value) return null;
  const address = new URL(value);
  if (!["http:", "https:"].includes(address.protocol) || address.username || address.password || address.search || address.hash) {
    throw new Error("Adresa služby AI musí být URL HTTP(S) bez přihlašovacích údajů a parametrů.");
  }
  const base = address.href.replace(/\/+$/, "");
  if (base.endsWith(suffix)) return base;
  if (suffix === "/v1/chat/completions" && base.endsWith("/v1")) return base + "/chat/completions";
  return base + suffix;
}

function names(value, variable, local = false) {
  const models = [...new Set((value ?? "").split(",").map((name) => name.trim()).filter(Boolean))];
  if (models.some((name) => !/^[\w./:-]{1,120}$/.test(name) ||
      (local && /(?:^|[-:])cloud(?:$|[-:])/i.test(name)))) {
    throw new Error(`${variable} obsahuje neplatný název modelu${local ? " nebo cloudový model" : ""}.`);
  }
  return models;
}

export function providerConfigs(env) {
  const custom = [
    { id: "ollama", label: "Ollama", env: "OLLAMA", kind: "ollama", suffix: "/api/chat" },
    { id: "custom", label: "Vlastní OpenAI kompatibilní API", env: "CUSTOM_AI", kind: "chat", suffix: "/v1/chat/completions" },
  ].map(({ id, label, env: prefix, kind, suffix }) => {
    const setting = prefix + "_URL";
    const endpoint = serviceEndpoint(env[setting], suffix);
    const models = names(env[prefix + "_MODELS"], prefix + "_MODELS", id === "ollama");
    const secret = id === "custom" ? env.CUSTOM_AI_API_KEY?.trim() : undefined;
    const external = endpoint && !["127.0.0.1", "localhost", "[::1]", "ollama"].includes(new URL(endpoint).hostname);
    return { id, label, kind, setting, endpoint, models: endpoint ? models : [], secret, cloud: false, external: Boolean(external) };
  });
  const cloud = cloudProviders.map(({ id, label, env: prefix, model, kind, url }) => {
    const setting = prefix + "_API_KEY";
    const secret = env[setting]?.trim();
    const models = names(env[prefix + "_MODELS"] || model, prefix + "_MODELS");
    return { id, label, kind, setting, endpoint: url, models: secret ? models : [], secret, cloud: true, external: true };
  });
  return [...custom, ...cloud];
}

export async function postModel(endpoint, data, label, { json = true, headers = {}, timeout = 120_000, fetcher = fetch } = {}) {
  let response;
  try {
    response = await fetcher(endpoint, {
      method: "POST", body: json ? JSON.stringify(data) : data,
      headers: json ? { "Content-Type": "application/json", ...headers } : headers,
      redirect: "error", signal: AbortSignal.timeout(timeout),
    });
  } catch {
    throw new InputError(`Se službou ${label} se nepodařilo spojit nebo vypršel čas zpracování.`);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new InputError(`${label} odmítl přístup. Ověřte klíč a oprávnění k modelu.`);
    if (response.status === 429) throw new InputError(`${label} ohlásil limit požadavků nebo kvóty.`);
    throw new InputError(`${label} vrátil chybu HTTP ${response.status}. Zkontrolujte službu a nastavení modelu.`);
  }
  try {
    return await response.json();
  } catch {
    throw new InputError(`${label} neposkytl očekávaný výstup JSON.`);
  }
}

export async function requestAnalysis(provider, model, messages, schema, fetcher = fetch) {
  const headers = provider.secret ? { Authorization: `Bearer ${provider.secret}` } : {};
  const options = { headers, timeout: provider.cloud ? 120_000 : 900_000, fetcher };
  if (provider.kind === "responses") {
    const result = await postModel(provider.endpoint, {
      model, input: messages, max_output_tokens: 1_800, store: false,
      text: { format: { type: "json_schema", name: "call_analysis", strict: true, schema } },
    }, provider.label, options);
    return result.output?.filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? []).filter((item) => item.type === "output_text")
      .map((item) => item.text).join("");
  }
  if (provider.kind === "ollama") {
    const result = await postModel(provider.endpoint, {
      model, messages, stream: false, think: false, format: schema,
      options: { temperature: 0, num_ctx: 16_384 },
    }, provider.label, options);
    return result.message?.content;
  }
  let tuning = {};
  if (provider.id === "groq" && model.startsWith("openai/gpt-oss-")) {
    tuning = { reasoning_effort: "low", max_completion_tokens: 1_800 };
  }
  const result = await postModel(provider.endpoint, {
    model, messages, stream: false, ...tuning,
    response_format: { type: "json_schema", json_schema: { name: "call_analysis", strict: true, schema } },
  }, provider.label, options);
  return result.choices?.[0]?.message?.content;
}
