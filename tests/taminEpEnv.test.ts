import "./setupEnv";
import { test } from "node:test";
import assert from "node:assert/strict";

// TAMIN_EP_ENV=test keeps the sandbox hosts and paths (guide v1.9.9);
// read once at module load, so it is set before the import.
process.env.TAMIN_EP_ENV = "test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { taminEpEnv, taminEpUrls, toTaminDocId, toTaminMobile } = require("../Lib/taminEp") as typeof import("../Lib/taminEp");

test("test environment uses the sandbox hosts", () => {
  assert.equal(taminEpEnv, "test");
  assert.equal(taminEpUrls.authorize, "https://account-pilot.tamin.ir/auth/server/authorize");
  assert.equal(taminEpUrls.token, "https://account-pilot.tamin.ir/auth/server/v2/token");
  assert.equal(taminEpUrls.sendEpresc, "https://ep-test.tamin.ir/api/v2/SendEpresc");
  assert.equal(
    taminEpUrls.remove("1", "2", "3"),
    "https://ep-test.tamin.ir/api/v2/ep/1/3/2",
  );
});

test("identity formats", () => {
  assert.equal(toTaminMobile("989121234567"), "09121234567");
  assert.equal(toTaminMobile("9121234567"), "09121234567");
  assert.equal(toTaminMobile("12"), undefined);
  assert.equal(toTaminDocId({ medicalSystemCode: "م-1234" }), "1234*");
  assert.equal(toTaminDocId({ medicalSystemCode: "1234" }), "1234");
});
