import ARI from "ari-client";
import { SIP_HOST, SIP_USERNAME, SIP_PASSWORD } from "./Env";

// Fire-and-forget: originates two SIP channels through the trunk on the
// Asterisk/ARI box and bridges them together. This is a reusable version of
// the flow already proven out in Controllers/adminController.ts (testSip) -
// we don't track the call's outcome (ringing/answered/hung up) here, we just
// hand it off to Asterisk.
export const originateSipCall = async (a: string, b: string): Promise<void> => {
  const client = await ARI.connect(SIP_HOST, SIP_USERNAME, SIP_PASSWORD);
  const bridge = await client.bridges.create({ type: "mixing" });
  client.start("ai-agent");
  client.on("StasisStart", async (e) => {
    await bridge.addChannel({ channel: e.channel.id });
  });
  await client.channels.originate({
    endpoint: `SIP/${a}@mytrunk`,
    app: "myapp",
    appArgs: "callA",
  });
  await client.channels.originate({
    endpoint: `SIP/${b}@mytrunk`,
    app: "myapp",
    appArgs: "callB",
  });
};
