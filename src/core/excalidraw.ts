import LZString from "lz-string";

// Excalidraw drawings are Markdown files whose scene is one JSON document, usually
// LZ-compressed and wrapped onto many lines. A line-by-line merge of that block can
// splice two compressed streams into an unreadable drawing, so drawings changed on
// both sides are merged element by element instead, the way Excalidraw reconciles
// collaborators: every element has an id and a version that goes up on each edit.

interface Element {
  id: string;
  version: number;
  versionNonce?: number;
  type?: string;
  [key: string]: unknown;
}

interface Scene {
  elements: Element[];
  files?: Record<string, unknown>;
  [key: string]: unknown;
}

interface Parsed {
  text: string;
  scene: Scene;
  compressed: boolean;
  /** Where the JSON sits inside `text`. */
  start: number;
  end: number;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const BLOCK = /```(compressed-json|json)\n([\s\S]*?)\n```/;

/**
 * True for files the Excalidraw plugin stores drawings in: named *.excalidraw.md or
 * *.excalidraw (conflict copies included), or a note whose front matter marks it.
 */
export function isDrawing(path: string, data: ArrayBuffer): boolean {
  if (/\.excalidraw( \([^/]*\))?(\.md)?$/.test(path)) return true;
  if (!path.endsWith(".md")) return false;
  const head = new TextDecoder().decode(data.slice(0, 1000));
  return head.startsWith("---") && /^excalidraw-plugin:/m.test(head);
}

function parse(data: ArrayBuffer): Parsed | null {
  let text: string;
  try {
    text = decoder.decode(data);
  } catch {
    return null;
  }
  // A plain .excalidraw file is the scene JSON itself.
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    const scene = toScene(text);
    return scene ? { text, scene, compressed: false, start: 0, end: text.length } : null;
  }
  const m = BLOCK.exec(text);
  if (!m) return null;
  const compressed = m[1] === "compressed-json";
  const body = compressed ? LZString.decompressFromBase64(m[2].replace(/\s/g, "")) : m[2];
  const scene = body ? toScene(body) : null;
  if (!scene) return null;
  const start = m.index + m[0].indexOf("\n") + 1;
  return { text, scene, compressed, start, end: start + m[2].length };
}

function toScene(json: string): Scene | null {
  try {
    const s = JSON.parse(json);
    if (!s || !Array.isArray(s.elements)) return null;
    if (!s.elements.every((e: Element) => e && typeof e.id === "string" && typeof e.version === "number")) return null;
    return s as Scene;
  } catch {
    return null;
  }
}

/** The Markdown around the scene, which holds text elements, links and embedded files. */
function outside(p: Parsed): string {
  return p.text.slice(0, p.start) + p.text.slice(p.end);
}

/** Of two copies of one element, the one Excalidraw would keep: higher version, then lower nonce. */
function newer(a: Element, b: Element): Element {
  if (a.version !== b.version) return a.version > b.version ? a : b;
  return (b.versionNonce ?? 0) < (a.versionNonce ?? 0) ? b : a;
}

const same = (a: Element | undefined, b: Element | undefined) => JSON.stringify(a) === JSON.stringify(b);

export type DrawingMerge =
  /** Our drawing already holds everything theirs added: keep the local file as it is. */
  | { kind: "keepOurs" }
  | { kind: "merged"; data: ArrayBuffer }
  /** Could not merge safely; the caller falls back to a conflict copy. */
  | { kind: "unmergeable" };

/**
 * Three-way merge of an Excalidraw drawing. Elements only one side changed take
 * that side's copy; elements both changed take the newer version; elements one side
 * deleted stay deleted unless the other side edited them. Our file's layout, app
 * state and Markdown are kept. Text changes coming from their side fall back to a
 * conflict copy, because the Markdown lists text elements separately and Excalidraw
 * would load the stale wording from it.
 */
export function mergeDrawing(base: ArrayBuffer | null, ours: ArrayBuffer, theirs: ArrayBuffer): DrawingMerge {
  const o = parse(ours);
  const t = parse(theirs);
  if (!o || !t) return { kind: "unmergeable" };
  const b = base ? parse(base) : null;

  const baseEls = new Map((b?.scene.elements ?? []).map((e) => [e.id, e]));
  const ourEls = new Map(o.scene.elements.map((e) => [e.id, e]));
  const theirEls = new Map(t.scene.elements.map((e) => [e.id, e]));

  const pick = new Map<string, Element>();
  for (const id of new Set([...ourEls.keys(), ...theirEls.keys()])) {
    const mine = ourEls.get(id);
    const theirsEl = theirEls.get(id);
    const was = baseEls.get(id);
    if (mine && theirsEl) pick.set(id, newer(mine, theirsEl));
    else if (mine) {
      // They removed it: honour that only if we left it as it was.
      if (!(was && same(was, mine))) pick.set(id, mine);
    } else if (theirsEl) {
      if (!(was && same(was, theirsEl))) pick.set(id, theirsEl);
    }
  }

  // Keep our stacking order. Elements they added go on top, as freshly drawn ones
  // do; ones we erased but they edited go back after their old neighbour.
  const order: string[] = o.scene.elements.map((e) => e.id).filter((id) => pick.has(id));
  let after: string | null = null;
  for (const e of t.scene.elements) {
    if (!pick.has(e.id)) continue;
    if (!order.includes(e.id)) {
      if (!baseEls.has(e.id)) order.push(e.id);
      else order.splice(after === null ? 0 : order.indexOf(after) + 1, 0, e.id);
    }
    after = e.id;
  }
  const elements = order.map((id) => pick.get(id)!);

  const files = { ...(t.scene.files ?? {}), ...(o.scene.files ?? {}) };
  const unchanged =
    elements.length === o.scene.elements.length &&
    elements.every((e, i) => e === o.scene.elements[i]) &&
    Object.keys(files).length === Object.keys(o.scene.files ?? {}).length;
  if (unchanged) return { kind: "keepOurs" };

  // Their text edits, or their Markdown (embedded files, links) differing from ours,
  // need more than a scene merge.
  const textFromThem = elements.some((e) => e.type === "text" && e !== ourEls.get(e.id));
  if (textFromThem) return { kind: "unmergeable" };
  if (b ? outside(t) !== outside(b) && outside(t) !== outside(o) : outside(t) !== outside(o)) {
    return { kind: "unmergeable" };
  }

  const scene: Scene = { ...o.scene, elements, files };
  const json = JSON.stringify(scene, null, o.compressed ? undefined : 2);
  const body = o.compressed ? wrap(LZString.compressToBase64(json)) : json;
  const text = o.text.slice(0, o.start) + body + o.text.slice(o.end);
  return { kind: "merged", data: new TextEncoder().encode(text).buffer as ArrayBuffer };
}

/** Excalidraw's own layout for compressed scenes: 256-character lines, blank lines between. */
function wrap(s: string): string {
  const lines: string[] = [];
  for (let i = 0; i < s.length; i += 256) lines.push(s.slice(i, i + 256));
  return lines.join("\n\n");
}
