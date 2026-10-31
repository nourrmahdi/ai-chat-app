export type ModelInfo = {
  id: string;
  name: string;
  provider: string;
  contextWindow: number; // max tokens the model can read at once
  bestFor: string;
  vision: boolean; // can the model look at images?
};

// Chat models the user can pick in the dropdown
export const MODELS: ModelInfo[] = [
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini", provider: "OpenAI",
    contextWindow: 128_000, bestFor: "Fast, reliable all-rounder", vision: true },
  { id: "anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", provider: "Anthropic",
    contextWindow: 1_000_000, bestFor: "Clear writing and reasoning", vision: true },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "Google",
    contextWindow: 1_048_576, bestFor: "Huge context, strong at images", vision: true },
  { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", provider: "Meta",
    contextWindow: 131_072, bestFor: "Open-weight, text only", vision: false },
  { id: "mistralai/mistral-small-3.2-24b-instruct", name: "Mistral Small 3.2", provider: "Mistral",
    contextWindow: 128_000, bestFor: "Lightweight, quick answers", vision: true },
];

// Image-generation model, used by the generateImage tool (not in the dropdown)
export const IMAGE_MODEL = {
  id: "google/gemini-2.5-flash-image",
  name: "Gemini 2.5 Flash Image",
  provider: "Google",
};

export const DEFAULT_MODEL = MODELS[0].id;

export function getModel(id?: string) {
  return MODELS.find((m) => m.id === id);
}

export function modelLabel(id?: string) {
  const m = getModel(id);
  return m ? `${m.name} · ${m.provider}` : "Unknown model";
}

// e.g. 128000 -> "128K", 1048576 -> "1M"
export function formatContext(tokens: number) {
  return tokens >= 1_000_000
    ? `${Math.round(tokens / 1_000_000)}M`
    : `${Math.round(tokens / 1000)}K`;
}