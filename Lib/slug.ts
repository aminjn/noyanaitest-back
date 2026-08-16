// Turns a title/name into a url-safe slug. Supports both Latin and
// Persian/Arabic script (this app's content is mostly Farsi), since a plain
// ASCII-only slugify would strip Persian text down to nothing.

// Normalize Arabic variants of Persian letters to their Persian form
// (ي -> ی, ك -> ک) so slugs stay consistent regardless of how the source
// text was typed.
const normalizePersian = (value: string): string =>
  value.replace(/ي/g, "ی").replace(/ك/g, "ک");

// Characters allowed in a slug: latin letters, digits, Persian/Arabic
// letters + digits, and hyphens (used as the word separator).
const ALLOWED_CHARS = /[^a-z0-9؀-ۿݐ-ݿ-]+/g;

export const slugify = (value: string | undefined | null): string => {
  if (!value) return "";

  let slug = normalizePersian(value.trim().toLowerCase());

  // whitespace and underscores become hyphens
  slug = slug.replace(/[\s_]+/g, "-");

  // strip anything that isn't a letter (latin/persian), digit, or hyphen
  slug = slug.replace(ALLOWED_CHARS, "");

  // collapse repeated hyphens and trim leading/trailing ones
  slug = slug.replace(/-+/g, "-").replace(/^-+|-+$/g, "");

  return slug;
};

export default slugify;
