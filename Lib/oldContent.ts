import { OldFiles } from "./oldFiles";

// Long text of the old site (articles) -> the rich-text JSON the new site
// renders (Slate: [{ type: "p", children: [{ text }] }, ...], see the
// frontend's Components/UI/RenderRtf.tsx, which shows nothing for anything
// that is not that JSON). Old values that already are that JSON are kept,
// only their image/video files are brought over (Lib/oldFiles.ts); HTML or
// plain text is converted to paragraphs, headings, lists, links and images.

type Leaf = { text: string; strong?: true; italic?: true; underline?: true; href?: string };
type Node = { type: string; children: (Node | Leaf)[]; level?: number; src?: string; alt?: string };

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  zwnj: "‌",
  rlm: "",
  lrm: "",
};

const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });

const attr = (attrs: string, name: string) => {
  const m = attrs.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? decode(m[2] ?? m[3] ?? m[4] ?? "") : undefined;
};

const BLOCK = new Set(["p", "div", "section", "article", "blockquote", "pre", "table", "tr", "figure", "figcaption", "header", "footer"]);

export const htmlToSlate = (html: string): { nodes: Node[]; images: Node[] } => {
  const nodes: Node[] = [];
  const images: Node[] = [];
  let leaves: Leaf[] = [];
  let blockType: { type: string; level?: number } = { type: "p" };
  const marks = { strong: 0, italic: 0, underline: 0 };
  const hrefs: string[] = [];
  const lists: Node[] = [];

  const flush = () => {
    const text = leaves.map((l) => l.text).join("");
    if (text.trim()) {
      const children = leaves.filter((l) => l.text);
      const node: Node = { type: blockType.type, children, ...(blockType.level ? { level: blockType.level } : {}) };
      if (node.type === "li" && lists.length) lists[lists.length - 1].children.push(node);
      else nodes.push(node);
    }
    leaves = [];
  };

  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let skip = 0;
  while ((m = re.exec(html))) {
    if (m[0].startsWith("<!--")) continue;
    const [, closing, rawTag, attrs, text] = m;
    if (text !== undefined) {
      if (skip) continue;
      const t = decode(text).replace(/[\r\n\t]+/g, " ");
      if (!t) continue;
      leaves.push({
        text: t,
        ...(marks.strong ? { strong: true as const } : {}),
        ...(marks.italic ? { italic: true as const } : {}),
        ...(marks.underline ? { underline: true as const } : {}),
        ...(hrefs.length && hrefs[hrefs.length - 1] ? { href: hrefs[hrefs.length - 1] } : {}),
      });
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (tag === "script" || tag === "style") {
      skip += closing ? -1 : 1;
      if (skip < 0) skip = 0;
      continue;
    }
    if (skip) continue;
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      flush();
      // the page title is the h1: an h1 in the text becomes an h2
      blockType = closing ? { type: "p" } : { type: "h", level: Math.max(2, Number(heading[1])) };
    } else if (tag === "ul" || tag === "ol") {
      flush();
      if (closing) {
        const list = lists.pop();
        if (list?.children.length) {
          if (lists.length) lists[lists.length - 1].children.push(list);
          else nodes.push(list);
        }
      } else lists.push({ type: tag, children: [] });
      blockType = { type: lists.length ? "li" : "p" };
    } else if (tag === "li") {
      flush();
      blockType = { type: lists.length ? "li" : "p" };
    } else if (tag === "br") {
      flush();
    } else if (BLOCK.has(tag)) {
      flush();
      if (closing && !lists.length) blockType = { type: "p" };
    } else if (tag === "img") {
      const src = attr(attrs, "src");
      if (src) {
        flush();
        const img: Node = { type: "img", src, alt: attr(attrs, "alt") || "", children: [{ text: "" }] };
        images.push(img);
        nodes.push(img);
      }
    } else if (tag === "strong" || tag === "b") marks.strong += closing ? -1 : 1;
    else if (tag === "em" || tag === "i") marks.italic += closing ? -1 : 1;
    else if (tag === "u") marks.underline += closing ? -1 : 1;
    else if (tag === "a") {
      if (closing) hrefs.pop();
      else hrefs.push(attr(attrs, "href") || "");
    }
    for (const k of Object.keys(marks) as (keyof typeof marks)[]) if (marks[k] < 0) marks[k] = 0;
  }
  flush();
  while (lists.length) {
    const list = lists.pop()!;
    if (list.children.length) nodes.push(list);
  }
  return { nodes, images };
};

const walkMedia = (nodes: unknown[], out: Node[]) => {
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    const node = n as Node;
    if ((node.type === "img" || node.type === "vid") && typeof node.src === "string") out.push(node);
    if (Array.isArray(node.children)) walkMedia(node.children, out);
  }
};

const plainToSlate = (text: string): Node[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => ({ type: "p", children: [{ text: l }] }));

// returns the Slate JSON string, or undefined for empty content
export const toSlateContent = async (raw: unknown, files: OldFiles): Promise<string | undefined> => {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = raw.trim();
  let nodes: Node[] | undefined;
  let media: Node[] = [];
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        nodes = parsed;
        walkMedia(parsed, media);
      }
    } catch {
      /* not JSON: treat as text */
    }
  }
  if (!nodes) {
    if (/<[a-z][\s\S]*>/i.test(value)) {
      const converted = htmlToSlate(value);
      nodes = converted.nodes;
      media = converted.images;
    } else nodes = plainToSlate(value);
  }
  for (const node of media) {
    const next = await files.resolve(node.src);
    if (next) node.src = next;
  }
  return nodes.length ? JSON.stringify(nodes) : undefined;
};
