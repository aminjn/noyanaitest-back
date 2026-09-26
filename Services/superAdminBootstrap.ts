import User from "../Models/User";
import { SUPER_ADMIN_PHONES } from "../Lib/Env";
import { isPhone } from "../Lib/validators";

export const bootstrapSuperAdmins = async () => {
  for (const raw of SUPER_ADMIN_PHONES) {
    const phone = isPhone(raw);
    if (!phone) {
      console.log(`[superAdmin] Invalid phone in SUPER_ADMIN_PHONES: ${raw}`);
      continue;
    }
    const user = await User.findOneAndUpdate(
      { phone },
      { $set: { role: "admin" }, $setOnInsert: { phone } },
      { upsert: true, new: true },
    );
    console.log(`[superAdmin] ${phone} is admin (${user._id})`);
  }
};
