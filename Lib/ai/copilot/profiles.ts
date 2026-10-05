// One assistant per profile (2026-10): its own instructions and the pages it
// may open. The tools of each profile live in Lib/ai/copilot/tools; the
// quick-action chips and the empty-state intro are in the frontend
// (Components/Ai/Copilot/copilotProfiles.ts), keyed by the same profile.
import { Profile, ProfileDef } from "./types";
import { SALES_FEATURES, SalesPart } from "../../business/crmProfiles";
import { partOn, ServicePart } from "../../business/crmService/profiles";

const FINANCE = [
  { key: "finance", path: "finance", hint: "finance overview (income, expenses, cash, receivables)" },
  { key: "finance.wallet", path: "finance/wallet", hint: "wallet and settlement" },
  { key: "finance.invoices", path: "finance/invoices", hint: "invoices" },
  { key: "finance.payments", path: "finance/payments", hint: "receipts, payments and cheques" },
  { key: "finance.expenses", path: "finance/expenses", hint: "expenses" },
  { key: "finance.accounting", path: "finance/accounting", hint: "accounting books, vouchers, ledger" },
  { key: "finance.moadian", path: "finance/moadian", hint: "Moadian electronic invoices (tax)" },
  { key: "finance.payroll", path: "finance/payroll", hint: "payroll, payslips" },
  { key: "finance.reports", path: "finance/reports", hint: "financial reports" },
];
const INSURANCE_CLAIMS = { key: "finance.insurance", path: "finance/insurance", hint: "insurance claims to insurers" };
const INVENTORY = { key: "finance.inventory", path: "finance/inventory", hint: "inventory, stock, batches, suppliers, purchases" };
const CRM = [
  { key: "crm", path: "crm", hint: "patient relations dashboard" },
  { key: "crm.contacts", path: "crm/contacts", hint: "patients / customers list" },
  { key: "crm.segments", path: "crm/segments", hint: "patient segments" },
  { key: "crm.campaigns", path: "crm/campaigns", hint: "SMS campaigns" },
  { key: "crm.automations", path: "crm/automations", hint: "automatic SMS journeys" },
  { key: "crm.followups", path: "crm/followups", hint: "follow-up tasks" },
  { key: "crm.templates", path: "crm/templates", hint: "SMS templates" },
];
// the CRM's sales and service pages this profile has (the same parts as its
// sidebar: Lib/business/crmProfiles.ts SALES_FEATURES and crmService/
// profiles.ts) and the panel's one approval inbox
const SALES_PAGES: Record<SalesPart, { path: string; hint: string }> = {
  pipeline: { path: "crm/pipeline", hint: "the lead funnel (treatment / sales pipeline) and its stages" },
  inquiries: { path: "crm/inquiries", hint: "estimate requests and web form inquiries" },
  plans: { path: "crm/plans", hint: "treatment plans / quotes sent to patients" },
  contracts: { path: "crm/contracts", hint: "corporate / insurer contracts and their signing" },
  carePlans: { path: "crm/care-plans", hint: "recurring care / refill plans" },
  calls: { path: "crm/calls", hint: "phone call log" },
  targets: { path: "crm/targets", hint: "sales targets and today's plan" },
  reports: { path: "crm/reports", hint: "sales reports" },
  settings: { path: "crm/sales-settings", hint: "sales settings: stages, sources, approvals, web form" },
};
const SERVICE_PAGES: Record<ServicePart, { path: string; hint: string }> = {
  club: { path: "crm/club", hint: "loyalty club: points, tiers, rewards" },
  sequences: { path: "crm/sequences", hint: "SMS sequences (drip messages)" },
  flows: { path: "crm/flows", hint: "automatic workflows" },
  tickets: { path: "crm/tickets", hint: "patient / customer requests and complaints (tickets with SLA)" },
  tasks: { path: "crm/tasks", hint: "the team's task boards" },
  timesheet: { path: "crm/timesheet", hint: "the team's logged hours" },
  calendar: { path: "crm/calendar", hint: "the team calendar" },
  checklists: { path: "crm/checklists", hint: "checklists (pre-visit, surgery, sampling)" },
  knowledge: { path: "crm/knowledge", hint: "the staff knowledge base" },
  quizzes: { path: "crm/quizzes", hint: "staff quizzes" },
  returns: { path: "crm/returns", hint: "returns and refunds" },
};
// a doctor working alone has no team to train: knowledge, quizzes and the
// timesheet stay out of the doctor's assistant like the sidebar
const TEAM_PARTS: ServicePart[] = ["knowledge", "quizzes", "timesheet"];
const crmPages = (p: Exclude<Profile, "user" | "admin">) => [
  ...CRM,
  ...SALES_FEATURES[p].parts.map((k) => ({ key: `crm.${k}`, ...SALES_PAGES[k] })),
  ...(Object.keys(SERVICE_PAGES) as ServicePart[])
    .filter((k) => partOn(p, k) && !(p === "doctor" && TEAM_PARTS.includes(k)))
    .map((k) => ({ key: `crm.${k}`, ...SERVICE_PAGES[k] })),
  { key: "kartabl", path: "kartabl", hint: "the approvals inbox (kartabl): discounts, returns, workflow steps, finance requests" },
];
const ORG_COMMON = [
  { key: "home", path: "", hint: "panel home" },
  { key: "profile", path: "profile", hint: "public profile" },
  { key: "secretary", path: "secretary", hint: "secretaries / staff and their access" },
  { key: "license", path: "license", hint: "plan and licence" },
  { key: "article", path: "article", hint: "articles / blog" },
];

const RULES = `Rules:
- Pick at most one tool. Use a tool only when the request needs it; otherwise just answer briefly.
- Never invent ids, names, numbers or dates; leave an argument out when it was not said.
- Tools that change data only prepare a form the user checks and confirms; say so in the reply.
- You are not a doctor: never diagnose, never recommend a treatment or a dose.
- Dates are YYYY-MM-DD (Gregorian). Times are HH:MM (24h). Relative days ("tomorrow", "فردا", "شنبه") are counted from today.`;

export const PROFILES: Record<Profile, ProfileDef> = {
  doctor: {
    profile: "doctor",
    prompt: `You are «دستیار نویان», the assistant of a physician's practice panel (the doctor, or a secretary working for the doctor).
You help with the day's schedule and visits, patients and their files, writing a prescription by voice or text, finance and patient relations (CRM).`,
    pages: [
      ...ORG_COMMON,
      { key: "schedule", path: "schedule", hint: "today's agenda and front desk" },
      { key: "calendar", path: "calendar", hint: "the calendar" },
      { key: "patients", path: "patient", hint: "patients list" },
      { key: "chat", path: "chat", hint: "chats with patients" },
      { key: "orders", path: "order", hint: "incoming orders" },
      { key: "shift", path: "shift", hint: "working hours / shifts" },
      { key: "office", path: "office", hint: "offices / addresses" },
      { key: "service", path: "service", hint: "services and prices" },
      { key: "review", path: "review", hint: "patient reviews" },
      { key: "settings", path: "settings", hint: "visit settings (in person, phone, video, chat)" },
      { key: "network", path: "network", hint: "clinics, hospitals, pharmacies, insurers" },
      { key: "prescription", path: "prescription", hint: "write a new prescription" },
      ...FINANCE,
      INSURANCE_CLAIMS,
      ...crmPages("doctor"),
    ],
  },
  clinic: {
    profile: "clinic",
    prompt: `You are «دستیار نویان», the assistant of a clinic's panel (the manager or a staff member).
You help with the clinic's doctors and departments, the schedule across doctors and occupancy, finance, payroll, inventory, insurance claims and patient relations (CRM).`,
    pages: [
      ...ORG_COMMON,
      { key: "doctors", path: "doctor", hint: "the clinic's doctors and join requests" },
      { key: "booking", path: "booking", hint: "the agenda across all doctors" },
      { key: "review", path: "review", hint: "reviews" },
      ...FINANCE,
      INSURANCE_CLAIMS,
      INVENTORY,
      ...crmPages("clinic"),
    ],
  },
  hospital: {
    profile: "hospital",
    prompt: `You are «دستیار نویان», the assistant of a hospital's panel (the manager or a staff member).
You help with the hospital's doctors and departments, the schedule across doctors and occupancy, finance, payroll, inventory, insurance claims and patient relations (CRM).`,
    pages: [
      ...ORG_COMMON,
      { key: "doctors", path: "doctor", hint: "the hospital's doctors and join requests" },
      { key: "booking", path: "booking", hint: "the agenda across all doctors" },
      { key: "review", path: "review", hint: "reviews" },
      ...FINANCE,
      INSURANCE_CLAIMS,
      INVENTORY,
      ...crmPages("hospital"),
    ],
  },
  pharmacy: {
    profile: "pharmacy",
    prompt: `You are «دستیار نویان», the assistant of a pharmacy's panel (the pharmacist or a staff member).
You help with the prescription and order queue, stock and expiry dates, reorder suggestions and purchases from distributors, finance and customers (CRM).`,
    pages: [
      ...ORG_COMMON,
      { key: "orders", path: "order", hint: "incoming orders queue" },
      { key: "prescriptions", path: "prescription", hint: "prescriptions to fill" },
      { key: "filled", path: "filledPrescription", hint: "filled prescriptions" },
      { key: "products", path: "product", hint: "products for sale" },
      { key: "packages", path: "productPackage", hint: "product packages" },
      ...FINANCE,
      INSURANCE_CLAIMS,
      INVENTORY,
      ...crmPages("pharmacy"),
    ],
  },
  paraClinic: {
    profile: "paraClinic",
    prompt: `You are «دستیار نویان», the assistant of a laboratory / imaging centre panel (the manager or a staff member).
You help with test orders and their results, kits and consumables inventory, finance and patient relations (CRM).`,
    pages: [
      ...ORG_COMMON,
      { key: "orders", path: "order", hint: "test orders and results" },
      { key: "tests", path: "test", hint: "the tests offered and prices" },
      { key: "review", path: "review", hint: "reviews" },
      ...FINANCE,
      INSURANCE_CLAIMS,
      INVENTORY,
      ...crmPages("paraClinic"),
    ],
  },
  insurance: {
    profile: "insurance",
    prompt: `You are «دستیار نویان», the assistant of an insurer's panel (the manager or a staff member).
You help with the insurance plans (contracts), the provider network, member (customer) questions through the CRM, and finance.`,
    pages: [
      ...ORG_COMMON,
      { key: "plans", path: "plan", hint: "insurance plans / contracts" },
      { key: "network", path: "network", hint: "the provider network" },
      { key: "review", path: "review", hint: "reviews" },
      ...FINANCE,
      ...crmPages("insurance"),
    ],
  },
  user: {
    profile: "user",
    prompt: `You are «دستیار نویان» in a patient's own dashboard. You help the patient with their bookings, orders, the doctor's instructions after a visit, wallet and the Pro membership.
For a health question (symptoms, a disease) do not answer medically: open the health assistant (the "assistant" page) so the triage assistant can help, and say that an emergency needs 115.`,
    pages: [
      { key: "home", path: "", hint: "dashboard home" },
      { key: "bookings", path: "booking", hint: "my bookings / visits" },
      { key: "orders", path: "order", hint: "my orders" },
      { key: "invoices", path: "invoice", hint: "my invoices" },
      { key: "wallet", path: "transaction", hint: "wallet and transactions" },
      { key: "chat", path: "chat", hint: "chats with doctors" },
      { key: "vitals", path: "vital", hint: "my vitals and medical details" },
      { key: "addresses", path: "address", hint: "addresses" },
      { key: "notifications", path: "notification", hint: "notifications" },
      { key: "pro", path: "pro", hint: "Noyan Pro membership" },
      { key: "support", path: "support", hint: "support tickets" },
      { key: "assistant", path: "/wizard", hint: "the AI health assistant (symptom triage)" },
      { key: "doctors", path: "/doctors", hint: "find a doctor and book" },
    ],
  },
  admin: {
    profile: "admin",
    prompt: `You are «دستیار نویان» for the platform's super admin / staff. You help with platform statistics, the provider requests queue,
users, the platform's own finance, and opening admin pages.`,
    pages: [
      { key: "home", path: "", hint: "admin dashboard" },
      { key: "requests", path: "requests", hint: "the provider requests queue (become doctor / clinic, memberships, additions)" },
      { key: "users", path: "user", hint: "users" },
      { key: "inbox", path: "inbox", hint: "inbox (contact requests, tickets, reports)" },
      { key: "finance", path: "finance", hint: "platform finance, payments, settlements" },
      { key: "reservations", path: "reservation", hint: "all reservations" },
      { key: "reviews", path: "reviews", hint: "reviews moderation" },
      { key: "comments", path: "comment", hint: "comments" },
      { key: "plans", path: "licensePlans", hint: "licence plans of providers" },
      { key: "settings", path: "appConfig", hint: "system settings (SMS, map, AI)" },
      { key: "ai", path: "appConfig?tab=ai", hint: "AI settings" },
      { key: "languages", path: "languages", hint: "site languages" },
      { key: "analytics", path: "analytics", hint: "site analytics" },
      { key: "tickets", path: "ticket", hint: "support tickets" },
      { key: "blog", path: "blog", hint: "blog posts" },
      { key: "doctors", path: "doctorprofile", hint: "doctor profiles" },
    ],
  },
};

export const rulesFor = () => RULES;

// API base and site path of a profile
export const apiOf = (p: Profile) => (p === "user" ? "/user" : p === "admin" ? "/admin" : `/${p}`);
export const panelPathOf = (p: Profile) =>
  p === "user"
    ? "/dashboard"
    : p === "admin"
      ? `/${process.env.ADMIN_KEY || "notadmin"}`
      : `/${p === "paraClinic" ? "paraClinicPanel" : `${p}panel`}`;
