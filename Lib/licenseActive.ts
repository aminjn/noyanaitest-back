// One rule for "is this provider's plan still running" (2026-10). A plan
// with no expiry (one an admin granted by hand) runs until it is changed:
// the module gate already read it that way, while the purchase guard read
// it as expired and let the provider buy a plan over the admin's grant.
type LicenseLike = { expiresAt?: Date | string | null } | null | undefined;

export const isLicenseExpired = (license: LicenseLike) =>
  !!license?.expiresAt && new Date(license.expiresAt) < new Date();

export const isLicenseActive = (license: LicenseLike) =>
  !!license && !isLicenseExpired(license);
