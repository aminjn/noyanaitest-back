import { ILabSampling, ILabSamplingProposal, LabSamplingKind, LabSamplingProposalStatus } from "../Models/LabSampling";

// How the lab's in-lab <-> home proposals of an appointment read
// (Lib/labSamplingProposal.ts). Kept apart so Lib/labSamplingReschedule.ts
// can attach the latest one to samplingMoveInfo without an import cycle.

const idOf = (value: unknown) => String((value as { _id?: unknown })?._id ?? value ?? "");

export const openProposalOf = (
  booking: Pick<ILabSampling, "proposals"> | null | undefined,
): ILabSamplingProposal | undefined =>
  (Array.isArray(booking?.proposals) ? booking!.proposals : []).find((p) => p?.status === "open");

// the proposal's status as the reader should see it: an "open" one past its
// time, or of an appointment that can no longer move, is over even before
// the sweep writes it
export const proposalStatusNow = (
  booking: Pick<ILabSampling, "status" | "collectedAt" | "feeSettled">,
  p: Pick<ILabSamplingProposal, "status" | "expiresAt">,
  now = new Date(),
): LabSamplingProposalStatus => {
  if (p.status !== "open") return p.status;
  if (booking.status !== "active" || booking.collectedAt || booking.feeSettled) return "closed";
  if (new Date(p.expiresAt).getTime() <= now.getTime()) return "expired";
  return "open";
};

export type SamplingProposalView = {
  _id: string;
  at: Date;
  kind: LabSamplingKind;
  ymd: string;
  start: number;
  end: number;
  startsAt: Date;
  fee: number;
  feeDelta: number;
  reason: string;
  expiresAt: Date;
  status: LabSamplingProposalStatus;
  answeredAt: Date | null;
};

// The latest proposal of an appointment (open or how it ended), for the
// buyer's order page, the lab's agenda and support's order page. The buyer
// also gets their wallet balance (the top-up offer) - `withWallet`.
export const latestProposalView = (
  booking: Pick<ILabSampling, "status" | "collectedAt" | "feeSettled" | "proposals">,
  now = new Date(),
): SamplingProposalView | null => {
  const list = Array.isArray(booking?.proposals) ? booking.proposals : [];
  const p = list[list.length - 1];
  if (!p || !p.ymd) return null;
  return {
    _id: idOf(p._id),
    at: p.at,
    kind: p.kind,
    ymd: p.ymd,
    start: p.start,
    end: p.end,
    startsAt: p.startsAt,
    fee: Number(p.fee) || 0,
    feeDelta: Number(p.feeDelta) || 0,
    reason: p.reason || "",
    expiresAt: p.expiresAt,
    status: proposalStatusNow(booking, p, now),
    answeredAt: p.answeredAt || null,
  };
};
