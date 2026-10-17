export type ModelInfo = { id: string; name: string; provider: string };

export const MODELS: ModelInfo[] = [
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini", provider: "OpenAI" },
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", provider: "Anthropic" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google" },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", provider: "Meta" },
  { id: "mistralai/mistral-small-3.2-24b-instruct", name: "Mistral Small 3.2", provider: "Mistral" },
];

export const DEFAULT_MODEL = MODELS[0].id;

export function modelLabel(id?: string) {
  const m = MODELS.find((m) => m.id === id);
  return m ? `${m.name} · ${m.provider}` : "Unknown model";
}