import mongoose, { Model } from "mongoose";
import { MongoDoc } from "./User";

export interface ITaminDrugAmount extends MongoDoc {
  drugAmntId?: string;
  drugAmntCode?: string;
  drugAmntSumry?: string;
  drugAmntLatin?: string;
  drugAmntConcept?: string;
  visibled?: string;
}

const TaminDrugAmountSchema = new mongoose.Schema<
  ITaminDrugAmount,
  Model<ITaminDrugAmount>
>({
  drugAmntId: { type: String },
  drugAmntCode: { type: String },
  drugAmntSumry: { type: String },
  drugAmntLatin: { type: String },
  drugAmntConcept: { type: String },
  visibled: { type: String },
});

const TaminDrugAmount = mongoose.model(
  "TaminDrugAmount",
  TaminDrugAmountSchema
);

export default TaminDrugAmount;
