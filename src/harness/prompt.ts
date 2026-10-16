import { readFileSync } from "node:fs";
import path from "node:path";

const PROMPTS_DIR = path.join(process.cwd(), "prompts");
const cache = new Map<string, string>();

export function loadPrompt(version: string): string {
  if (!/^v\d+$/.test(version)) throw new Error(`Invalid prompt version "${version}"`);
  const cached = cache.get(version);
  if (cached) return cached;
  const text = readFileSync(path.join(PROMPTS_DIR, `system.${version}.md`), "utf8");
  cache.set(version, text);
  return text;
}

/** Replaces {{name}} placeholders. Unknown placeholders are an error, not silently left in. */
export function renderPrompt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Missing prompt variable "${name}"`);
    return value;
  });
}

export function currentPromptVersion(): string {
  return process.env.PROMPT_VERSION || "v2";
}
