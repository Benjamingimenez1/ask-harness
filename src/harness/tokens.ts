// Rough token estimate (~4 characters per token for English text).
// Good enough for budgeting context; it is not used for billing. Swapping in a
// real tokenizer would only change this one function.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
