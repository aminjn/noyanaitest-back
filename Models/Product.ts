import mongoose, { Model } from "mongoose";

export interface IProduct {}

const ProductSchema = new mongoose.Schema<IProduct, Model<IProduct>>({});

const Product = mongoose.model("Product", ProductSchema);

export default Product;
