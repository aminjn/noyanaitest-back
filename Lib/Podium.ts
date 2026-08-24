import moment from "moment-jalaali";
import { IUser } from "../Models/User";
import * as env from "../Lib/Env";
import { getAppConfig } from "./appConfig";
import {
  IdentityResponse,
  MatchNationalIdAndPhoneNumberResponse,
  PodiumIdentityInfo,
  PodiumReponse,
} from "../Controllers/authController";
import BadEvent from "../Models/BadEvent";

export const getPodiumIdentity = async ({
  birthdate,
  nationalId,
  requester,
}: {
  birthdate: Date;
  nationalId: string;
  requester?: IUser;
}): Promise<
  | { status: true; error?: never; data: PodiumIdentityInfo }
  | { status: false; error: string; data?: never }
> => {
  try {
    const { podiumToken, getIdentityInfoApiKey } = await getAppConfig();
    const jBirthDate = moment(birthdate).format("jYYYYjMMjDD");
    const response = await fetch(env.podiumUrl, {
      headers: {
        Authorization: `bearer ${podiumToken}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      body: JSON.stringify({
        productEntityId: 46659320,
        apiKey: getIdentityInfoApiKey,
        providerParameters: {
          nationalCode: nationalId,
          birthDate: jBirthDate,
        },
      }),
    });
    const identityData = (await response.json()) as PodiumReponse;
    if (identityData.hasError || !identityData.result) {
      await BadEvent.create({
        place: "GetOtherIdentity",
        payload: JSON.stringify({
          incoming: requester?._id,
          error: identityData.message,
          result: identityData.result,
        }),
      });
      return {
        status: false,
        error: "سرویس مورد نظر به مشکل خورده لطفا بعدا دوباره امتحان کنید",
      };
    }
    const incomingIdentityInfo = JSON.parse(
      identityData.result,
    ) as IdentityResponse;
    if (!incomingIdentityInfo.identityInfo) {
      await BadEvent.create({
        place: "GetOtherIdentity",
        payload: JSON.stringify({
          incoming: requester?._id,
          error: incomingIdentityInfo.message,
        }),
      });
      return { status: false, error: incomingIdentityInfo.message };
    }
    if (!incomingIdentityInfo.identityInfo.alive) {
      await BadEvent.create({
        place: "GetOtherIdentity",
        payload: JSON.stringify({
          incoming: requester?._id,
          error: "Dead Guy",
        }),
      });
      return { status: false, error: "شخص موردنظر متوفی میباشد" };
    }
    return { status: true, data: incomingIdentityInfo.identityInfo };
  } catch (err) {
    await BadEvent.create({
      place: "GetOtherIdentity",
      payload: JSON.stringify({
        incoming: requester?._id,
        errro: err instanceof Error ? err.message : "UNKOWN",
      }),
    });
    return {
      status: false,
      error: err instanceof Error ? err.message : "Unknown Error",
    };
  }
};

export const shahkar = async ({
  nationalCode,
  phone,
  requester,
}: {
  nationalCode: string;
  phone: string;
  requester?: IUser;
}): Promise<
  | { status: true; data: boolean; error?: never }
  | { status: false; error: string; data?: never }
> => {
  try {
    const { podiumToken, matchNationalIdAndPhoneNumberApiKey } =
      await getAppConfig();
    const response = await fetch(env.podiumUrl, {
      method: "POST",
      headers: {
        Authorization: `bearer ${podiumToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        productEntityId: "46645324",
        apiKey: matchNationalIdAndPhoneNumberApiKey,
        providerParameters: {
          body: {
            nationalCode: nationalCode,
            mobileNumber: phone,
          },
        },
      }),
    });
    const data = (await response.json()) as PodiumReponse;
    if (!data.result) {
      await BadEvent.create({
        place: "matchNationalIdAndPhoneOther",
        payload: JSON.stringify({
          incoming: phone,
          errro: "Bad Response",
        }),
      });
      return { status: false, error: "مشکلی در دریافت اطلاعات پیش آمد" };
    }
    try {
      const matchResult = JSON.parse(
        data.result,
      ) as MatchNationalIdAndPhoneNumberResponse;
      if (!matchResult.matched)
        return {
          status: false,
          error: "این شماره موبایل با کد ملی وارد شده تطابق ندارد",
        };
      return { status: true, data: true };
    } catch {
      await BadEvent.create({
        place: "matchNationalIdAndPhoneOther",
        payload: JSON.stringify({
          incoming: requester?._id,
          errro: "Response is NOt JSON",
        }),
      });
      return { status: false, error: "مشکلی در دریافت اطلاعات پیش آمد" };
    }
  } catch (e) {
    await BadEvent.create({
      place: "matchNationalIdAndPhoneOther",
      payload: JSON.stringify({
        incoming: requester?._id,
        errro: e instanceof Error ? e.message : "Unknown",
      }),
    });
    return {
      status: false,
      error: e instanceof Error ? e.message : "Unknown Error",
    };
  }
};
