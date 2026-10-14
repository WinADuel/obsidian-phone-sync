import { merge } from "node-diff3";

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Line-by-line three-way merge of a text file edited on both sides since `base`.
 * Returns the merged bytes, or null when the two edits overlap (or a side is not
 * valid UTF-8 text) and a person has to choose.
 */
export function mergeText(base: ArrayBuffer, ours: ArrayBuffer, theirs: ArrayBuffer): ArrayBuffer | null {
  let o: string, a: string, b: string;
  try {
    o = decoder.decode(base);
    a = decoder.decode(ours);
    b = decoder.decode(theirs);
  } catch {
    return null;
  }
  const { conflict, result } = merge(a.split("\n"), o.split("\n"), b.split("\n"));
  if (conflict) return null;
  return new TextEncoder().encode(result.join("\n")).buffer as ArrayBuffer;
}
