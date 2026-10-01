// A stored secret (an API key) as the admin panel may see it: enough to
// recognise it, never enough to use it.
export const maskSecret = (value?: string | null) => {
  if (!value) return "";
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
};

// a masked value sent back unchanged: never stored over the real secret
export const isMaskedSecret = (value: unknown) =>
  typeof value === "string" && value.includes("••");
