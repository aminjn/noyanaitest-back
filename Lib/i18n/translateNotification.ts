import { notificationMessages } from "./notificationMessages";
import { buildCatalog, fillTemplate, localizeValue } from "./translateMessage";
import { Locale, SOURCE_LOCALE } from "../locales";

// System notifications (Models/Notification.ts) and staff push alerts
// (Services/userAlertService.ts) are written in Persian, like the error
// messages. They are stored as written and translated when they're read:
// the in-app list uses the request's x-locale, and a push uses the language
// its browser subscribed in (PushSubscription.locale). A text that isn't in
// the catalog (an admin's own broadcast, say) comes back unchanged.

const { exact, patterns } = buildCatalog(notificationMessages);

// A value such as "کلینیک مهر" (an org kind followed by its name): the
// leading kind word is translated and the name is kept.
const translateValue = (value: string, locale: Locale) => {
  const whole = exact.get(value)?.[locale];
  if (whole) return whole;
  const space = value.indexOf(" ");
  if (space > 0) {
    const head = exact.get(value.slice(0, space))?.[locale];
    if (head) return `${head}${value.slice(space)}`;
  }
  return value;
};

// "clinic Mehr has been added" -> "Clinic Mehr has been added"
const capitalize = (text: string) =>
  text.charAt(0).toLocaleUpperCase() + text.slice(1);

export const translateNotificationText = (
  text: string,
  locale: Locale,
): string => {
  if (locale === SOURCE_LOCALE || typeof text !== "string" || !text) return text;
  const normalized = text.replace(/\s+/g, " ").trim();
  const hit = exact.get(normalized)?.[locale];
  if (hit) return hit;
  for (const { regex, translations } of patterns) {
    const match = normalized.match(regex);
    if (match && translations[locale])
      return capitalize(
        fillTemplate(translations[locale]!, match.slice(1), locale, (v) =>
          // amounts come formatted in Persian digits; phone numbers and
          // codes (ASCII digits) are kept as they are
          /[۰-۹]/.test(v)
            ? localizeValue(v, locale)
            : translateValue(v.trim(), locale),
        ),
      );
  }
  const value = translateValue(normalized, locale);
  return value === normalized ? text : capitalize(value);
};

// { title, message } (a Notification document or a push payload) in `locale`.
export const translateNotification = <
  T extends { title?: string; message?: string },
>(
  notification: T,
  locale: Locale,
): T => ({
  ...notification,
  title: translateNotificationText(notification.title ?? "", locale),
  message: translateNotificationText(notification.message ?? "", locale),
});
