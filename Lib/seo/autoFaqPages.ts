// The page types with an automatic FAQ (Lib/autoFaq.ts), each switched off
// by the super admin in «سئوی خودکار» (SeoTemplate.autoFaq === false); on by
// default. Kept import-free so the SEO resolver can read it.
export const autoFaqPages = [
  "/dr/[slug]",
  "/clinic/[slug]",
  "/hospital/[slug]",
  "/paraClinic/[slug]",
  "/pharmacy/[slug]",
] as const;
export type AutoFaqPage = (typeof autoFaqPages)[number];
export const isAutoFaqPage = (path: string): path is AutoFaqPage =>
  (autoFaqPages as readonly string[]).includes(path);
