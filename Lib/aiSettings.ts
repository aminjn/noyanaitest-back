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

export type AiProvider =
  | { kind: "anthropic"; key: string; model: string; baseUrl: string }
  | { kind: "openai"; key: string; model: string; baseUrl: string }
  | { kind: "ollama"; host: string; model: string };

export const AI_DEFAULT_BASE: Record<"anthropic" | "openai", string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};
export const AI_DEFAULT_MODEL = "claude-sonnet-5";

const trimUrl = (v?: string | null) => String(v || "").trim().replace(/\/+$/, "");
const pick = (...values: (string | undefined | null)[]) =>
  values.map((v) => String(v ?? "").trim()).find(Boolean) || "";

export type AiSettings = {
  ollamaHost: string;
  cloud: { kind: "anthropic" | "openai"; key: string; baseUrl: string } | undefined;
  provider: AiProviderKind;
  translation: AiProvider | undefined;
  clinical: AiProvider | undefined;
  stt: { url: string; key: string; model: string; language: string } | undefined;
};

export const getAiSettings = async (): Promise<AiSettings> => {
  const c = await getAppConfig();
  const env = process.env;
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

  const build = (kind: AiProviderKind, model: string): AiProvider | undefined => {
    if (!model) return;
    if (kind === "ollama") return ollamaHost ? { kind, host: ollamaHost, model } : undefined;
    if (!cloud) return;
    return cloud.kind === "openai" ? { ...cloud, kind: "openai", model } : { ...cloud, kind: "anthropic", model };
  };

  // translation
  const translationModel = pick(
    c.translationAiModel,
    provider === "ollama" ? env.TRANSLATION_OLLAMA_MODEL : env.TRANSLATION_MODEL,
    provider === "ollama" ? "" : AI_DEFAULT_MODEL,
  );
  const translationOn =
    c.translationAiEnabled ?? !!(env.ANTHROPIC_API_KEY || env.TRANSLATION_OLLAMA_MODEL);
  const translation = translationOn ? build(provider, translationModel) : undefined;

  // clinical assistant
  const clinicalKind: AiProviderKind =
    c.clinicalAiProvider === "cloud"
      ? cloudKind
      : c.clinicalAiProvider === "ollama"
        ? "ollama"
        : env.CLINICAL_AI_PROVIDER === "anthropic"
          ? "anthropic"
          : "ollama";
  const clinicalModel = pick(
    c.clinicalAiModel,
    clinicalKind === "ollama" ? env.CLINICAL_OLLAMA_MODEL : env.CLINICAL_AI_MODEL,
    clinicalKind === "ollama" ? "" : AI_DEFAULT_MODEL,
  );
  const clinicalOn =
    c.clinicalAiEnabled ??
    !!(env.CLINICAL_AI_PROVIDER === "anthropic" ? env.ANTHROPIC_API_KEY : env.CLINICAL_OLLAMA_MODEL);
  const clinical = clinicalOn ? build(clinicalKind, clinicalModel) : undefined;

  // speech to text
  const sttUrl = trimUrl(pick(c.sttUrl, env.STT_URL));
  const sttOn = c.sttEnabled ?? !!env.STT_URL;
  const stt =
    sttOn && sttUrl
      ? {
          url: sttUrl,
          key: pick(c.sttApiKey, env.STT_API_KEY),
          model: pick(c.sttModel, env.STT_MODEL, "whisper-1"),
          language: pick(c.sttLanguage, env.STT_LANGUAGE, "fa"),
        }
      : undefined;

  return { ollamaHost, cloud, provider, translation, clinical, stt };
};

// The Ollama server address, or an error the admin can act on.
export const getOllamaHost = async () => {
  const { ollamaHost } = await getAiSettings();
  if (!ollamaHost) throw new Error("آدرس سرور Ollama در تنظیمات هوش مصنوعی وارد نشده است");
  return ollamaHost;
};

type CompleteOptions = { system?: string; maxTokens?: number; json?: boolean; timeoutMs?: number };

// One chat completion against any of the three providers.
export const aiComplete = async (
  p: AiProvider,
  user: string,
  { system, maxTokens = 4000, json, timeoutMs = 120_000 }: CompleteOptions = {},
): Promise<string> => {
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
    headers: { "content-type": "application/json" },
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
