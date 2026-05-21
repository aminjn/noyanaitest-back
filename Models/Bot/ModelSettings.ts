import { MongoDoc } from "../User";

import mongoose, { Model } from "mongoose";
import { IOllamaModel } from "./OllamaModel";

export interface IModelOptions extends MongoDoc {
  ollamaModel: IOllamaModel;
  numa: boolean;
  num_ctx: number;
  num_batch: number;
  num_gpu: number;
  main_gpu: number;
  low_vram: boolean;
  f16_kv: boolean;
  logits_all: boolean;
  vocab_only: boolean;
  use_mmap: boolean;
  use_mlock: boolean;
  embedding_only: boolean;
  num_thread: number;
  num_keep: number;
  seed: number;
  num_predict: number;
  top_k: number;
  top_p: number;
  tfs_z: number;
  typical_p: number;
  repeat_last_n: number;
  temperature: number;
  repeat_penalty: number;
  presence_penalty: number;
  frequency_penalty: number;
  mirostat: number;
  mirostat_tau: number;
  mirostat_eta: number;
  penalize_newline: boolean;
  stop: string[];
}

const ModelOptionsSchema = new mongoose.Schema<
  IModelOptions,
  Model<IModelOptions>
>({
  ollamaModel: {
    type: mongoose.Schema.ObjectId,
    ref: "OllamaModel",
    required: true,
    unique: true,
  },
  numa: { type: Boolean },
  num_ctx: { type: Number },
  num_batch: { type: Number },
  num_gpu: { type: Number },
  main_gpu: { type: Number },
  low_vram: { type: Boolean },
  f16_kv: { type: Boolean },
  logits_all: { type: Boolean },
  vocab_only: { type: Boolean },
  use_mmap: { type: Boolean },
  use_mlock: { type: Boolean },
  embedding_only: { type: Boolean },
  num_thread: { type: Number },
  num_keep: { type: Number },
  seed: { type: Number },
  num_predict: { type: Number },
  top_k: { type: Number },
  top_p: { type: Number },
  tfs_z: { type: Number },
  typical_p: { type: Number },
  repeat_last_n: { type: Number },
  temperature: { type: Number },
  repeat_penalty: { type: Number },
  presence_penalty: { type: Number },
  frequency_penalty: { type: Number },
  mirostat: { type: Number },
  mirostat_tau: { type: Number },
  mirostat_eta: { type: Number },
  penalize_newline: { type: Boolean },
  stop: { type: [String] },
});

const ModelOptions = mongoose.model("ModelOptions", ModelOptionsSchema);

export default ModelOptions;
