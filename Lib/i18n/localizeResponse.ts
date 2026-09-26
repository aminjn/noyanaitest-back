import { RequestHandler } from "express";
import { Locale } from "../locales";
import { currentLocale } from "./requestContext";

const hasValue = (value: unknown) =>
  Array.isArray(value)
    ? value.some((item) => typeof item === "string" && item.trim())
    : typeof value === "string" && value.trim() !== "";

// Replace translated fields in place and drop every `translations` bag.
const overlay = (node: unknown, locale: Locale): void => {
  if (Array.isArray(node)) {
    for (const item of node) overlay(item, locale);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  const translations = record.translations as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (translations && typeof translations === "object") {
    const own = locale !== "fa" ? translations[locale] : undefined;
    if (own && typeof own === "object")
      for (const [key, value] of Object.entries(own))
        if (hasValue(value)) record[key] = value;
    delete record.translations;
  }
  for (const value of Object.values(record)) overlay(value, locale);
};

// For public (visitor-facing) routes: the response shows DB content in the
// request's language. Panels and admin keep the raw documents - they edit
// the Persian source and manage translations separately.
export const localizeResponse: RequestHandler = (_req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body?: unknown) => {
    if (body && typeof body === "object") {
      // Round-trip through JSON so mongoose documents become plain data.
      const plain = JSON.parse(JSON.stringify(body));
      overlay(plain, currentLocale());
      return json(plain);
    }
    return json(body);
  };
  next();
};
