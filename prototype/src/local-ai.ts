import { isLocalModel } from './pi-command.ts';

export const tokenCount = (value: string) => {
  const match = /^(\d+(?:\.\d+)?)([KMB]?)$/.exec(value);
  return match ? Number(match[1]) * ({ '': 1, K: 1000, M: 1e6, B: 1e9 }[match[2]] ?? 1) : 0;
};
export function contextGuidance(model: string): string {
  return `Couldn’t learn how much text ${model} can read. ${model.startsWith('ollama/')
    ? 'In Ollama, set the context length (for example 32768) in its settings or with OLLAMA_CONTEXT_LENGTH, restart Ollama, then try again.'
    : 'In LM Studio, set the context length when loading the model, then try again.'}`;
}
/** Estimate 3 Unicode characters/token, plus 25% and 512 fixed tokens for framing/tokenizer variation. */
export function assertLocalContext(model: string, context: number, output: number, text: string) {
  if (context <= 1) throw new Error(contextGuidance(model));
  const estimated = Math.ceil(Array.from(text).length / 3 * 1.25);
  if (estimated + 512 + output > context) {
    throw new Error(`${model}: the transcript may exceed this model's context window (${context} tokens). Notes were not sent or truncated. Choose a model with a larger context window.`);
  }
}
export function localFailure(model: string, message: string): string {
  return isLocalModel(model) && /(?:does not|doesn't|cannot|unsupported|not support).*(?:tools|function.call)|(?:tools|function.call).*(?:unsupported|not support)/i.test(message)
    ? `${model} cannot call tools. Choose a tool-capable model for plans and actions. ${message}` : message;
}
