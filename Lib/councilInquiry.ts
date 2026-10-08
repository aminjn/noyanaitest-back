import * as env from "./Env";
import BadEvent from "../Models/BadEvent";

// The medical council (IRIMC) inquiry through the Podium gateway (2026-10,
// one doctor onboarding flow, Controllers/doctorOnboardingController.ts).
// Two calls: the codes registered for a national id, then one code's degree
// (title, city, date). "unavailable" means the service could not answer
// (not configured, network, gateway error) - the applicant may then go on
// with a manual entry an admin checks; "error" is the council's own answer
// (no such record) and stops the flow.

export type InquiryResult<T> =
  | { status: "ok"; data: T }
  | { status: "unavailable" }
  | { status: "error"; message: string };

type PodiumResponse = {
  hasError: boolean;
  message?: string;
  result?: { result?: string };
};

type CouncilResult<T> = { Result: T | null; IsSuccess: boolean; Message: string | null };

const log = (place: string, phone: string, error: unknown) =>
  BadEvent.create({
    place,
    payload: JSON.stringify({ incoming: phone, error: error instanceof Error ? error.message : String(error || "UNKNOWN") }),
  }).catch(() => {});

const call = async <T>(
  place: string,
  phone: string,
  apiKey: string,
  productId: string,
  fields: Record<string, string>,
): Promise<InquiryResult<T>> => {
  if (!apiKey || !env.PODIUM_TOKEN) return { status: "unavailable" };
  const params = new URLSearchParams({ scProductId: productId, scApiKey: apiKey, ...fields });
  let parsed: CouncilResult<T>;
  try {
    const response = await fetch(env.podiumUrl2, {
      method: "POST",
      headers: {
        _token_: env.PODIUM_TOKEN,
        _token_issuer_: "1",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
      signal: AbortSignal.timeout(15000),
    });
    const data = (await response.json()) as PodiumResponse;
    if (data.hasError || !data.result?.result) throw new Error(data.message || "gateway error");
    parsed = JSON.parse(data.result.result) as CouncilResult<T>;
  } catch (e) {
    await log(place, phone, e);
    return { status: "unavailable" };
  }
  if (!parsed.IsSuccess || !parsed.Result) {
    await log(place, phone, parsed.Message || "no result");
    return { status: "error", message: parsed.Message || "کد نظام پزشکی شما در سامانه نظام پزشکی یافت نشد" };
  }
  return { status: "ok", data: parsed.Result };
};

export const councilCodesOf = async (nationalId: string, phone: string): Promise<InquiryResult<string[]>> => {
  const res = await call<{ McCode: string }[]>(
    "GetMedicalCodes",
    phone,
    env.GET_MEDICAL_SYSTEM_CODE_API_KEY,
    "45682",
    { nationalCode: nationalId },
  );
  if (res.status !== "ok") return res;
  return {
    status: "ok",
    data: (Array.isArray(res.data) ? res.data : []).map((el) => String(el?.McCode || "").trim()).filter(Boolean),
  };
};

export type CouncilDegree = { title?: string; city?: string; acquiredAt?: string };

export const councilDegreeOf = async (mcCode: string, phone: string): Promise<InquiryResult<CouncilDegree>> => {
  const res = await call<{ Spec_DegreeFieldTitle?: string; Spec_InstituteCityTitle?: string; Spec_DateShamsi?: string }>(
    "GetMcDetails",
    phone,
    env.GET_MC_CERTIFICATE_API_KEY,
    "115027",
    { mcCode },
  );
  if (res.status !== "ok") return res;
  return {
    status: "ok",
    data: {
      title: res.data.Spec_DegreeFieldTitle || undefined,
      city: res.data.Spec_InstituteCityTitle || undefined,
      acquiredAt: res.data.Spec_DateShamsi || undefined,
    },
  };
};
