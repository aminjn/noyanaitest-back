import { getAppConfig } from "./appConfig";

// AI providers of the platform, set by the super admin (system settings ->
// AI, Models/AppConfig.ts). A field left empty there falls back to the old
// .env variable, so an install configured through .env keeps working.
//
//   Machine translation of content: aiProvider (anthropic | openai | ollama)
//   Clinical assistant (doctor panel): clinicalAiProvider. Patient data is
//     sensitive, so it uses the in-country Ollama server unless the admin
//     explicitly picks the cloud provider.
//   Visit scribe speech-to-text: any OpenAI-compatible transcription server.
//   Wizard chat bot: the Ollama server (model picked in the bot settings).

export type AiProviderKind = "anthropic" | "openai" | "ollama";

// `instruction`: the admin's own guidance for the feature, added after the
// feature's built-in system prompt (never in place of it)
export type AiProvider =
  | { kind: "anthropic"; key: string; model: string; baseUrl: string; instruction?: string }
  | { kind: "openai"; key: string; model: string; baseUrl: string; instruction?: string }
  | { kind: "ollama"; host: string; model: string; key?: string; instruction?: string };

// an Ollama server behind a key (a reverse proxy in front of it) gets it as
// a bearer token on every request
export const ollamaHeaders = (key?: string): Record<string, string> => (key ? { authorization: `Bearer ${key}` } : {});

const withInstruction = (system: string | undefined, p: AiProvider) =>
  [system, p.instruction ? `Additional instructions from the site administrator:\n${p.instruction}` : ""]
    .filter(Boolean)
    .join("\n\n") || undefined;

export const AI_DEFAULT_BASE: Record<"anthropic" | "openai", string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};
export const AI_DEFAULT_MODEL = "claude-sonnet-5";

const trimUrl = (v?: string | null) => String(v || "").trim().replace(/\/+$/, "");
const pick = (...values: (string | undefined | null)[]) =>
  values.map((v) => String(v ?? "").trim()).find(Boolean) || "";

// The AI features of the site (2026-10). One connection serves them all;
// each has its own switch, model and instruction (system settings -> AI).
export const AI_FEATURES = ["translation", "content", "clinical", "finance", "chat", "stt"] as const;
export type AiFeature = (typeof AI_FEATURES)[number];
export type AiFeatureConfig = { enabled?: boolean; model?: string; instruction?: string; language?: string };

export type AiSettings = {
  ollamaHost: string;
  // the connection's key, sent to the Ollama server too when it has one
  ollamaKey: string;
  cloud: { kind: "anthropic" | "openai"; key: string; baseUrl: string } | undefined;
  provider: AiProviderKind;
  // the one connection, as the admin entered it
  connection: { kind: AiProviderKind; url: string; hasKey: boolean };
  translation: AiProvider | undefined;
  // medical content written or checked by AI, and the import's name split
  content: AiProvider | undefined;
  clinical: AiProvider | undefined;
  finance: AiProvider | undefined;
  // the public health chat (Ollama only: it streams through the Ollama client)
  chat: { model: string; instruction: string } | undefined;
  stt: { url: string; key: string; model: string; language: string } | undefined;
  // why a feature that is on can't run (shown by the connection test)
  missing: Partial<Record<AiFeature, string>>;
};

// An Ollama feature with no model typed uses a model the server actually
// has (2026-10): the first chat model it lists (not an embedding model),
// cached for five minutes. A server that doesn't answer gives none.
let ollamaModelCache: { host: string; at: number; model: string; reached: boolean } | undefined;
const ollamaReached = (host: string) => !ollamaModelCache || ollamaModelCache.host !== host || ollamaModelCache.reached;
const ollamaDefaultModel = async (host: string, key = ""): Promise<string> => {
  if (!host) return "";
  if (ollamaModelCache && ollamaModelCache.host === host && Date.now() - ollamaModelCache.at < 5 * 60_000)
    return ollamaModelCache.model;
  let model = "";
  let reached = false;
  try {
    const r = await fetch(`${host}/api/tags`, { headers: ollamaHeaders(key), signal: AbortSignal.timeout(5_000) });
    reached = r.ok;
    if (r.ok) {
      const body = (await r.json()) as { models?: { name?: string }[] };
      model = (body.models || []).map((m) => String(m.name || "")).find((n) => n && !/embed/i.test(n)) || "";
    }
  } catch {
    /* no model: the feature reports what is missing */
  }
  ollamaModelCache = { host, at: Date.now(), model, reached };
  return model;
};

const FEATURE_OFF: Record<AiFeature, string> = {
  translation: "ترجمه‌ی ماشینی خاموش است",
  content: "هوش مصنوعی محتوای پزشکی خاموش است",
  clinical: "دستیار بالینی خاموش است",
  finance: "دستیار مالی خاموش است",
  chat: "دستیار گفتگوی سلامت خاموش است",
  stt: "تبدیل گفتار به متن خاموش است",
};

export const getAiSettings = async (): Promise<AiSettings> => {
  const c = await getAppConfig();
  const env = process.env;
  const features = ((c as { aiFeatures?: Partial<Record<AiFeature, AiFeatureConfig>> }).aiFeatures || {}) as Partial<
    Record<AiFeature, AiFeatureConfig>
  >;
  const feat = (f: AiFeature): AiFeatureConfig => features[f] || {};
  const ollamaHost = trimUrl(pick(c.ollamaHost, env.OLLAMA_HOST));
  const envProvider: AiProviderKind = env.ANTHROPIC_API_KEY ? "anthropic" : "ollama";
  const provider = (c.aiProvider || envProvider) as AiProviderKind;
  // the cloud account used by any feature set to a cloud provider
  const cloudKind: "anthropic" | "openai" = provider === "openai" ? "openai" : "anthropic";
  const key = pick(c.aiApiKey, cloudKind === "anthropic" ? env.ANTHROPIC_API_KEY : "");
  const baseUrl = trimUrl(
    pick(c.aiBaseUrl, cloudKind === "anthropic" ? env.ANTHROPIC_BASE_URL : "", AI_DEFAULT_BASE[cloudKind]),
  );
  const cloud = key ? { kind: cloudKind, key, baseUrl } : undefined;
  const ollamaKey = pick(c.aiApiKey, env.OLLAMA_API_KEY);

  const build = (kind: AiProviderKind, model: string, instruction?: string): AiProvider | undefined => {
    if (!model) return;
    const extra = instruction?.trim() ? { instruction: instruction.trim() } : {};
    if (kind === "ollama")
      return ollamaHost ? { kind, host: ollamaHost, model, ...(ollamaKey ? { key: ollamaKey } : {}), ...extra } : undefined;
    if (!cloud) return;
    return cloud.kind === "openai"
      ? { ...cloud, kind: "openai", model, ...extra }
      : { ...cloud, kind: "anthropic", model, ...extra };
  };
  const ollamaFallback = async (kind: AiProviderKind) => (kind === "ollama" ? await ollamaDefaultModel(ollamaHost, ollamaKey) : "");

  // translation
  const translationModel =
    pick(
      feat("translation").model,
      c.translationAiModel,
      provider === "ollama" ? env.TRANSLATION_OLLAMA_MODEL : env.TRANSLATION_MODEL,
      provider === "ollama" ? "" : AI_DEFAULT_MODEL,
    ) || (await ollamaFallback(provider));
  const translationOn =
    feat("translation").enabled ?? c.translationAiEnabled ?? !!(env.ANTHROPIC_API_KEY || env.TRANSLATION_OLLAMA_MODEL);
  const translation = translationOn ? build(provider, translationModel, feat("translation").instruction) : undefined;

  // medical content and import: their own model, or the translation one
  const contentModel = pick(feat("content").model, translationModel);
  const contentOn = feat("content").enabled ?? translationOn;
  const content = contentOn ? build(provider, contentModel, feat("content").instruction) : undefined;

  // clinical assistant
  const clinicalKind: AiProviderKind =
    c.clinicalAiProvider === "cloud"
      ? cloudKind
      : c.clinicalAiProvider === "ollama"
        ? "ollama"
        : env.CLINICAL_AI_PROVIDER === "anthropic"
          ? "anthropic"
          : provider === "ollama"
            ? "ollama"
            : provider;
  const clinicalModel =
    pick(
      feat("clinical").model,
      c.clinicalAiModel,
      clinicalKind === "ollama" ? env.CLINICAL_OLLAMA_MODEL : env.CLINICAL_AI_MODEL,
      clinicalKind === "ollama" ? "" : AI_DEFAULT_MODEL,
    ) || (await ollamaFallback(clinicalKind));
  const clinicalOn =
    feat("clinical").enabled ??
    c.clinicalAiEnabled ??
    !!(env.CLINICAL_AI_PROVIDER === "anthropic" ? env.ANTHROPIC_API_KEY : env.CLINICAL_OLLAMA_MODEL);
  const clinical = clinicalOn ? build(clinicalKind, clinicalModel, feat("clinical").instruction) : undefined;

  // finance and accounting: its own model, or the clinical one (it reads the
  // same kind of private data, so it follows the clinical provider)
  const financeModel = pick(feat("finance").model, clinicalModel);
  const financeOn = feat("finance").enabled ?? clinicalOn;
  const finance = financeOn ? build(clinicalKind, financeModel, feat("finance").instruction) : undefined;

  // the health chat: an Ollama model (the bot settings' default one when
  // none is chosen here)
  const chatOn = feat("chat").enabled ?? !!ollamaHost;
  const chat = chatOn && ollamaHost ? { model: pick(feat("chat").model), instruction: (feat("chat").instruction || "").trim() } : undefined;

  // speech to text: the connection itself (an OpenAI-compatible server with
  // a transcription model) unless a separate address is set
  const sttUrl = trimUrl(pick(c.sttUrl, env.STT_URL, provider === "openai" ? baseUrl : ""));
  const sttOn = feat("stt").enabled ?? c.sttEnabled ?? !!env.STT_URL;
  const stt =
    sttOn && sttUrl
      ? {
          url: sttUrl,
          key: pick(c.sttApiKey, env.STT_API_KEY, c.sttUrl ? "" : provider === "openai" ? key : ""),
          model: pick(feat("stt").model, c.sttModel, env.STT_MODEL, "whisper-1"),
          language: pick(feat("stt").language, c.sttLanguage, env.STT_LANGUAGE, "fa"),
        }
      : undefined;

  // what a feature that is on still lacks, in the admin's words
  const lack = (kind: AiProviderKind, model: string): string | undefined => {
    if (kind === "ollama") {
      if (!ollamaHost) return "آدرس سرور Ollama در تنظیمات هوش مصنوعی وارد نشده است";
      if (!model && !ollamaReached(ollamaHost)) return "سرور در دسترس نیست؛ آدرس و دسترسی شبکه‌ی سرور را بررسی کنید";
      if (!model) return "هیچ مدلی روی سرور Ollama نصب نیست؛ نام مدل را وارد کنید یا یک مدل روی سرور نصب کنید";
      return;
    }
    if (!cloud) return "کلید API سرویس ابری وارد نشده است";
    if (!model) return "نام مدل وارد نشده است";
  };
  const missing: Partial<Record<AiFeature, string>> = {
    translation: !translationOn ? FEATURE_OFF.translation : translation ? undefined : lack(provider, translationModel),
    content: !contentOn ? FEATURE_OFF.content : content ? undefined : lack(provider, contentModel),
    clinical: !clinicalOn ? FEATURE_OFF.clinical : clinical ? undefined : lack(clinicalKind, clinicalModel),
    finance: !financeOn ? FEATURE_OFF.finance : finance ? undefined : lack(clinicalKind, financeModel),
    chat: !chatOn ? FEATURE_OFF.chat : chat ? undefined : "دستیار گفتگو فقط با سرور Ollama کار می‌کند؛ آدرس Ollama وارد نشده است",
    stt: !sttOn
      ? FEATURE_OFF.stt
      : stt
        ? undefined
        : "این اتصال گفتار به متن ندارد؛ یک سرور سازگار با OpenAI (Whisper) وصل کنید یا آدرس جدای گفتار به متن را وارد کنید",
  };

  const connection = {
    kind: provider,
    url: provider === "ollama" ? ollamaHost : trimUrl(pick(c.aiBaseUrl)),
    hasKey: !!key,
  };
  return { ollamaHost, ollamaKey, cloud, provider, connection, translation, content, clinical, finance, chat, stt, missing };
};

// The Ollama server address, or an error the admin can act on.
export const getOllamaHost = async () => {
  const { ollamaHost } = await getAiSettings();
  if (!ollamaHost) throw new Error("آدرس سرور Ollama در تنظیمات هوش مصنوعی وارد نشده است");
  return ollamaHost;
};

// the Ollama client's settings: the address and, when the server sits
// behind a key, its bearer header
export const getOllamaClientConfig = async () => {
  const { ollamaHost, ollamaKey } = await getAiSettings();
  if (!ollamaHost) throw new Error("آدرس سرور Ollama در تنظیمات هوش مصنوعی وارد نشده است");
  return { host: ollamaHost, headers: ollamaHeaders(ollamaKey) };
};

type CompleteOptions = { system?: string; maxTokens?: number; json?: boolean; timeoutMs?: number };

// One chat completion against any of the three providers.
export const aiComplete = async (
  p: AiProvider,
  user: string,
  { system: baseSystem, maxTokens = 4000, json, timeoutMs = 120_000 }: CompleteOptions = {},
): Promise<string> => {
  const system = withInstruction(baseSystem, p);
  const signal = AbortSignal.timeout(timeoutMs);
  if (p.kind === "anthropic") {
    const response = await fetch(`${p.baseUrl}/v1/messages`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: p.model,
        max_tokens: maxTokens,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!response.ok) throw new Error(`Anthropic API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const data = (await response.json()) as { content?: { text?: string }[] };
    return (data.content || []).map((block) => block.text || "").join("");
  }
  const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user }];
  if (p.kind === "openai") {
    const response = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ model: p.model, max_tokens: maxTokens, messages }),
    });
    if (!response.ok) throw new Error(`OpenAI-compatible API ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content || "";
  }
  const response = await fetch(`${p.host}/api/chat`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...ollamaHeaders(p.key) },
    body: JSON.stringify({
      model: p.model,
      stream: false,
      ...(json ? { format: "json" } : {}),
      options: { temperature: 0.2 },
      messages,
    }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const data = (await response.json()) as { message?: { content?: string } };
  return data.message?.content || "";
};


// A file the model reads with the prompt (a receipt's photo or PDF), base64.
export type AiAttachment = { mime: string; data: string };

// The provider answered that it cannot read the attachment (a text-only
// model): the caller falls back to asking the user for the text.
export class AiNoVisionError extends Error {}

const NO_VISION = /image|vision|multimodal|multi-modal|content.*type|unsupported.*(file|document|media)|does not support/i;

// One chat completion with images (and, where the provider reads them,
// PDFs): Anthropic image / document blocks, OpenAI-compatible image_url /
// file parts, Ollama's images list (vision models such as qwen2.5vl).
export const aiCompleteWithImage = async (
  p: AiProvider,
  user: string,
  files: AiAttachment[],
  { system: baseSystem, maxTokens = 4000, json, timeoutMs = 180_000 }: CompleteOptions = {},
): Promise<string> => {
  const system = withInstruction(baseSystem, p);
  const signal = AbortSignal.timeout(timeoutMs);
  const refuse = async (response: Response, name: string) => {
    const body = (await response.text()).slice(0, 300);
    if (response.status >= 400 && response.status < 500 && response.status !== 401 && response.status !== 429 && NO_VISION.test(body))
      throw new AiNoVisionError(`${name} ${response.status}: ${body}`);
    throw new Error(`${name} ${response.status}: ${body}`);
  };
  if (p.kind === "anthropic") {
    const content = [
      ...files.map((f) =>
        f.mime === "application/pdf"
          ? { type: "document", source: { type: "base64", media_type: f.mime, data: f.data } }
          : { type: "image", source: { type: "base64", media_type: f.mime, data: f.data } },
      ),
      { type: "text", text: user },
    ];
    const response = await fetch(`${p.baseUrl}/v1/messages`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: p.model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: [{ role: "user", content }] }),
    });
    if (!response.ok) await refuse(response, "Anthropic API");
    const data = (await response.json()) as { content?: { text?: string }[] };
    return (data.content || []).map((block) => block.text || "").join("");
  }
  if (p.kind === "openai") {
    const content = [
      { type: "text", text: user },
      ...files.map((f) =>
        f.mime === "application/pdf"
          ? { type: "file", file: { filename: "receipt.pdf", file_data: `data:${f.mime};base64,${f.data}` } }
          : { type: "image_url", image_url: { url: `data:${f.mime};base64,${f.data}` } },
      ),
    ];
    const messages = [...(system ? [{ role: "system", content: system }] : []), { role: "user", content }];
    const response = await fetch(`${p.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ model: p.model, max_tokens: maxTokens, messages }),
    });
    if (!response.ok) await refuse(response, "OpenAI-compatible API");
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content || "";
  }
  // Ollama reads images only; a PDF has to come as text
  const images = files.filter((f) => f.mime !== "application/pdf").map((f) => f.data);
  if (!images.length) throw new AiNoVisionError("Ollama reads images only");
  const response = await fetch(`${p.host}/api/chat`, {
    method: "POST",
    signal,
    headers: { "content-type": "application/json", ...ollamaHeaders(p.key) },
    body: JSON.stringify({
      model: p.model,
      stream: false,
      ...(json ? { format: "json" } : {}),
      options: { temperature: 0.1 },
      messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: user, images }],
    }),
  });
  if (!response.ok) await refuse(response, "Ollama");
  const data = (await response.json()) as { message?: { content?: string } };
  return data.message?.content || "";
};
