import ARI from "ari-client";
import { getAppConfig } from "./appConfig";

export type SipLeg = "doctor" | "patient";

export interface SipCallHandles {
  bridgeId: string;
  doctorChannelId: string;
  patientChannelId: string;
}

// Originates two SIP channels through the trunk on the Asterisk/ARI box and
// bridges them together once each answers. This is a reusable version of
// the flow already proven out in Controllers/adminController.ts (testSip).
// Unlike the original version, we now also report back when each leg
// actually answers (via onLegAnswered) so callers can track presence -
// still fire-and-forget from the caller's point of view (the returned
// promise resolves once both legs have been originated, not once anyone
// answers), we just no longer throw away the answer events.
export const originateSipCall = async (
  doctorPhone: string,
  patientPhone: string,
  onLegAnswered?: (leg: SipLeg, channelId: string) => void,
): Promise<SipCallHandles> => {
  const { sipHost, sipUsername, sipPassword } = await getAppConfig();
  const client = await ARI.connect(sipHost, sipUsername, sipPassword);
  const bridge = await client.bridges.create({ type: "mixing" });
  client.start("ai-agent");
  client.on("StasisStart", async (event, channel) => {
    await bridge.addChannel({ channel: channel.id });
    // appArgs comes back on the event as `args`, which ari-client types as
    // `string | string[]` (in practice an array here since we pass a single
    // string appArgs, but guard both shapes) - this is how we tell the two
    // legs apart rather than relying on channel id timing, since a leg can
    // answer before originate() below has even resolved with its channel id.
    const arg = Array.isArray(event.args) ? event.args[0] : event.args;
    if (arg === "callA") onLegAnswered?.("doctor", channel.id);
    else if (arg === "callB") onLegAnswered?.("patient", channel.id);
  });
  const doctorChannel = await client.channels.originate({
    endpoint: `SIP/${doctorPhone}@mytrunk`,
    app: "myapp",
    appArgs: "callA",
  });
  const patientChannel = await client.channels.originate({
    endpoint: `SIP/${patientPhone}@mytrunk`,
    app: "myapp",
    appArgs: "callB",
  });
  return {
    bridgeId: bridge.id,
    doctorChannelId: doctorChannel.id,
    patientChannelId: patientChannel.id,
  };
};
