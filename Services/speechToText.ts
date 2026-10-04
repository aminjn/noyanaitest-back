// Speech-to-text for the visit scribe, through any OpenAI-compatible
// transcription server - e.g. a self-hosted faster-whisper inside Iran. Set
// by the super admin (system settings -> AI, Lib/aiSettings.ts).
// The audio lives only in memory for this request; it is never stored.
import { getAiSettings } from "../Lib/aiSettings";

export const speechToTextEnabled = async () => !!(await getAiSettings()).stt;

export const transcribe = async (audio: Buffer, mimeType: string, fileName = "visit.webm"): Promise<string> => {
  const stt = (await getAiSettings()).stt;
  if (!stt) throw new Error("Speech-to-text is not configured");
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mimeType || "audio/webm" }), fileName);
  form.append("model", stt.model);
  form.append("language", stt.language);
  form.append("response_format", "json");
  const response = await fetch(`${stt.url}/audio/transcriptions`, {
    method: "POST",
    headers: stt.key ? { authorization: `Bearer ${stt.key}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`STT ${response.status}`);
  const data = (await response.json()) as { text?: string };
  return (data.text || "").trim();
};
