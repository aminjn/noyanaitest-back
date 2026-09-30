import { IBaseLicensePricing } from "../Models/BaseLicensePricing";

// Shared by every <org>Controller's license catalog + purchase (2026-09).

// the periods (in days) at least one of these plans sells, shortest first -
// the plan pages' period switcher
export const licenseDurationsOf = (
  licenses: { pricing?: IBaseLicensePricing[] }[],
): number[] =>
  Array.from(
    new Set(
      licenses.flatMap((license) =>
        (license.pricing || [])
          .filter((p) => p.isActive && p.days > 0)
          .map((p) => p.days),
      ),
    ),
  ).sort((a, b) => a - b);

// the option a purchase asks for - only an active one is for sale
export const findActivePricing = (
  pricing: IBaseLicensePricing[] | undefined,
  days: number,
) => (pricing || []).find((p) => p.isActive && p.days === days);
