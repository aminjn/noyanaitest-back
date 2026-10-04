import { translatable } from "../Lib/i18n/translatable";
import mongoose, { Model } from "mongoose";
import { clearsDirectoryCache } from "../Lib/directoryCache";
import { MongoDoc } from "./User";

// The drug's therapeutic class (2026-10), e.g. «آنتی‌بیوتیک‌ها»,
// «مسکن‌ها», «داروهای فشار خون»: the "by class" entry of the drug directory
// (/drug/class/<slug>), as Drugs.com and Medscape group medicines. It was a
// free "tag" shown nowhere; the collection and Drug.tag are kept (no data
// move), the meaning is now the class. Admin: «داروها» > «گروه‌های درمانی».
export interface IDrugTag extends MongoDoc {
  name?: string;
  slug?: string;
  isActive: boolean;
  order: number;
}

const DrugTagSchema = new mongoose.Schema<IDrugTag, Model<IDrugTag>>({
  name: { type: String, trim: true, required: true },
  slug: { type: String, trim: true, unique: true, sparse: true },
  isActive: { type: Boolean, default: false },
  order: { type: Number, default: 0 },
});

DrugTagSchema.plugin(translatable);
clearsDirectoryCache(DrugTagSchema);

const DrugTag = mongoose.model("DrugTag", DrugTagSchema);

export default DrugTag;
