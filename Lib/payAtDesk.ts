// Pay at the desk (2026-10): a doctor may turn it off for their in-person
// visits, or only at some offices (Models/InPersonSettings.ts). Missing
// fields mean on, the behaviour before the setting existed. One rule for
// the quote the booking page reads (Lib/bookingFlow.ts) and the booking
// itself (Controllers/bookingController.ts).
export const deskPayAllowed = (
  settings: { payAtDesk?: boolean | null; payAtDeskOff?: unknown[] | null } | null | undefined,
  office?: unknown,
) => {
  if (!settings || settings.payAtDesk === false) return false;
  if (!office) return true;
  const off = Array.isArray(settings.payAtDeskOff) ? settings.payAtDeskOff.map(String) : [];
  return !off.includes(String(office));
};
