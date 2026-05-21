import mongoose, { Model } from "mongoose";
import { MongoDoc } from "../User";

export interface IBotInstruction extends MongoDoc {
  content: string;
  order: number;
  isActive: boolean;
  createdAt: Date;
}

const BotInstructionSchema = new mongoose.Schema<
  IBotInstruction,
  Model<IBotInstruction>
>({
  content: { type: String },
  order: { type: Number, default: 0 },
  isActive: { type: Boolean, default: false },
  createdAt: { type: Date, default: () => new Date() },
});

const BotInstruction = mongoose.model("BotInstruction", BotInstructionSchema);

export default BotInstruction;
