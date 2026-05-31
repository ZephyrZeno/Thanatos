export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function truncate(s: string, max = 240): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Best-effort JSON extraction from a model response that may wrap JSON in prose
 * or ```json fences. Returns `undefined` if nothing parseable is found.
 */
export function extractJson<T = unknown>(text: string): T | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(text);

  // Also try the substring between the first { and the last }.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const c of candidates) {
    try {
      return JSON.parse(c.trim()) as T;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}

/** Deterministic stable color from a string (HSL), for visualization. */
export function colorFromString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 70% 55%)`;
}
