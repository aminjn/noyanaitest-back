import { AsyncLocalStorage } from "async_hooks";
import { RequestHandler } from "express";
import { defaultLocale, Locale, requestLocale } from "../locales";

// The current request's language, readable from anywhere down the call
// chain (mongoose query hooks in particular) without threading it through.
const store = new AsyncLocalStorage<{ locale: Locale }>();

export const localeContext: RequestHandler = (req, _res, next) =>
  store.run({ locale: requestLocale(req.headers) }, next);

export const currentLocale = (): Locale =>
  store.getStore()?.locale ?? defaultLocale;
