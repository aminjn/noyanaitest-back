// A provider's public contact links (2026-10): the website, the land line
// and the social pages a doctor fills in on their profile, checked on the
// way in (doctorController) and again on the way out to the public page
// (publicController.getDoctorProfile), so the /dr page only ever links to
// an http(s) site, a dialable number, or the social network's own domain.
// Each returns the canonical form, "" for an empty value (clears it), or
// null when the value is not valid.

const toLatinDigits = (s: string) =>
  s
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

const parseUrl = (raw: string): URL | null => {
  const value = raw.trim();
  if (!value || /\s/.test(value) || value.length > 300) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    // a real host name: labels with a dot and a top-level part
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(host) && !/^xn--/.test(host)) return null;
    return url;
  } catch {
    return null;
  }
};

export const normalizeWebsite = (raw: unknown): string | null => {
  if (typeof raw !== "string") return raw == null ? "" : null;
  if (!raw.trim()) return "";
  const url = parseUrl(raw);
  return url ? url.toString() : null;
};

// a land line: digits, an optional leading +, 7 to 15 digits
export const normalizeLandLine = (raw: unknown): string | null => {
  if (typeof raw !== "string") return raw == null ? "" : null;
  const value = toLatinDigits(raw).replace(/[\s\-().]/g, "");
  if (!value) return "";
  if (!/^\+?\d{7,15}$/.test(value)) return null;
  return value;
};

export type SocialKind = "Instagram" | "Telegarm" | "Whatsapp" | "Aparat";

const socialRules: Record<
  SocialKind,
  { hosts: string[]; handle: RegExp; url: (handle: string) => string }
> = {
  Instagram: {
    hosts: ["instagram.com", "www.instagram.com", "instagr.am"],
    handle: /^[A-Za-z0-9._]{1,30}$/,
    url: (h) => `https://instagram.com/${h}`,
  },
  Telegarm: {
    hosts: ["t.me", "telegram.me", "www.telegram.me"],
    handle: /^[A-Za-z0-9_]{4,32}$/,
    url: (h) => `https://t.me/${h}`,
  },
  Whatsapp: {
    hosts: ["wa.me", "api.whatsapp.com", "whatsapp.com", "www.whatsapp.com"],
    handle: /^\d{8,15}$/,
    url: (h) => `https://wa.me/${h}`,
  },
  Aparat: {
    hosts: ["aparat.com", "www.aparat.com"],
    handle: /^[A-Za-z0-9_.-]{1,60}$/,
    url: (h) => `https://www.aparat.com/${h}`,
  },
};

// WhatsApp takes the number in international form: an Iranian 09... or
// 9... mobile becomes 989...
const whatsappNumber = (raw: string) => {
  const d = toLatinDigits(raw).replace(/[\s\-()+]/g, "");
  if (/^09\d{9}$/.test(d)) return `98${d.slice(1)}`;
  if (/^9\d{9}$/.test(d)) return `98${d}`;
  if (/^0098\d{10}$/.test(d)) return d.slice(2);
  return d;
};

// "@name", "name" or a link on the network's own domain -> its canonical
// https link; a link to any other site is refused
export const normalizeSocial = (media: unknown, raw: unknown): string | null => {
  const rule = socialRules[media as SocialKind];
  if (!rule || typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value) return null;
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:/i.test(value) || /^[^\s/@]+\.[a-z]{2,}\//i.test(value) || rule.hosts.some((h) => value.toLowerCase().startsWith(h));
  let handle: string;
  if (looksLikeUrl) {
    const url = parseUrl(value);
    if (!url || !rule.hosts.includes(url.hostname.toLowerCase())) return null;
    if (media === "Whatsapp" && url.searchParams.get("phone")) handle = url.searchParams.get("phone") || "";
    else handle = decodeURIComponent(url.pathname.split("/").filter(Boolean)[0] || "");
  } else handle = value.replace(/^@/, "");
  if (media === "Whatsapp") handle = whatsappNumber(handle);
  return rule.handle.test(handle) ? rule.url(handle) : null;
};
