// Speech-to-text for the visit scribe, through any OpenAI-compatible
// transcription server - e.g. a self-hosted faster-whisper inside Iran.
// The audio lives only in memory for this request; it is never stored.
//
//   STT_URL       base URL, e.g. "http://127.0.0.1:8000/v1"; unset = off
//   STT_MODEL     default "whisper-1"
//   STT_API_KEY   optional bearer token
//   STT_LANGUAGE  default "fa"
export const speechToTextEnabled = () => !!process.env.STT_URL;

export const transcribe = async (audio: Buffer, mimeType: string, fileName = "visit.webm"): Promise<string> => {
  const base = process.env.STT_URL?.replace(/\/$/, "");
  if (!base) throw new Error("Speech-to-text is not configured");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType || "audio/webm" }), fileName);
  form.append("model", process.env.STT_MODEL || "whisper-1");
  form.append("language", process.env.STT_LANGUAGE || "fa");
  form.append("response_format", "json");
  const response = await fetch(`${base}/audio/transcriptions`, {
    method: "POST",
    headers: process.env.STT_API_KEY ? { authorization: `Bearer ${process.env.STT_API_KEY}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`STT ${response.status}`);
  const data = (await response.json()) as { text?: string };
  return (data.text || "").trim();
};
