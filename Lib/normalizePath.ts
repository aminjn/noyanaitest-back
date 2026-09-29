// One canonical form for stored and looked-up paths: decoded (the browser
// sends Persian slugs percent-encoded), no trailing slash.
export const normalizePath = (path: string) => {
  let value = path.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // keep as is
  }
  if (value.length > 1) value = value.replace(/\/+$/, "");
  return value;
};
