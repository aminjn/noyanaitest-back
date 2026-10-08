import { RequestHandler } from "express";

// What a patient sees of their own reservations (2026-10). A visit at a
// clinic's or hospital's office whose insurer contract the centre holds
// carries, on each insurer line, the doctor's agreed percentage of the
// insurer's payment and the amount the centre owes the doctor
// (Lib/centreInsurerSplit.ts, Models/Reservation.ts). That is between the
// centre and the doctor - like a practice's fee split on Doctolib or
// Docplanner, it never reaches the patient's app. The doctor, the centre and
// support keep seeing it through their own routes.
//
// One sanitizer for every patient-facing response (the /user routes - their
// reservations, bookings, family members' visits, dashboard, invoices - the
// booking quote and finalize, the «پرو» booking quote and the payment
// result): it is applied to the JSON body, so a new endpoint under those
// routers is covered without remembering it.

const SPLIT_KEYS = ["doctorPercent", "doctorShare", "doctorDeducted", "doctorDeductions"] as const;

const stripLine = (line: unknown) => {
  if (!line || typeof line !== "object") return;
  for (const key of SPLIT_KEYS) delete (line as Record<string, unknown>)[key];
};

// Removes the doctor/centre split from every `insuranceQuote` found in the
// value (in place). Depth-limited, and anything that is not an object or an
// array is left as it is.
export const stripInsurerSplit = <T>(value: T, depth = 0): T => {
  if (!value || typeof value !== "object" || depth > 40) return value;
  if (Array.isArray(value)) {
    for (const item of value) stripInsurerSplit(item, depth + 1);
    return value;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const child = record[key];
    if (key === "insuranceQuote" && child && typeof child === "object") {
      const lines = (child as { lines?: unknown }).lines;
      if (Array.isArray(lines)) lines.forEach(stripLine);
    }
    stripInsurerSplit(child, depth + 1);
  }
  return value;
};

// the middleware: every JSON body the router sends is sanitized
export const patientReservationView: RequestHandler = (_req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body?: unknown) => {
    if (body && typeof body === "object") {
      // documents (mongoose, ObjectIds, dates) become plain JSON first
      const plain = JSON.parse(JSON.stringify(body));
      return json(stripInsurerSplit(plain));
    }
    return json(body);
  };
  next();
};
