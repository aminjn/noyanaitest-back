import mongoose, { Model } from "mongoose";

export interface IService {}

const ServiceSchema = new mongoose.Schema<IService, Model<IService>>({});

const Service = mongoose.model("Service", ServiceSchema);

export default Service;
