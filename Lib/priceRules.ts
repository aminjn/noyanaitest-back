import mongoose from "mongoose";

// A discount never above its price, on a new or edited record alike (an
// edit through findOneAndUpdate runs this as an update validator, where
// `this` is the query and the price comes from the same update). A price
// left out of the update is not checked against here.
export const discountWithinPrice = {
  validator: function (this: unknown, discount: number) {
    let price: unknown;
    if (this instanceof mongoose.Query) {
      const update = (this.getUpdate() || {}) as Record<string, any>;
      price = update.$set?.price ?? update.price;
    } else price = (this as { price?: unknown })?.price;
    if (price === undefined || price === null) return true;
    return Number(discount || 0) <= Number(price);
  },
  message: "تخفیف نمی‌تواند از قیمت بیشتر باشد",
};
