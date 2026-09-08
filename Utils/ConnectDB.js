// import mongoose from "mongoose";
// //connection to db ..
// const Connection = () => mongoose.connect('mongodb+srv://biswajitshrm6:7DL0Lz8dxicjlXQJ@users.mt5yvfh.mongodb.net/FlashFire')
//                     .then(()=>console.log("Database connected succesfully..!"))
//                     .catch((e)=>console.log('Problem while connecting to db', e));

// export default Connection

import mongoose from "mongoose";
import dotenv from "dotenv";
import { BdaClaim02Model } from "../Schema_Models/BdaClaim02.js";

dotenv.config();

console.log("[MongoDB] ConnectDB module loaded — mongo-resilience build (retry+reconnect enabled)");

/**
 * One-time, idempotent index reconciliation run after the first connect.
 * bda_claim02 originally had a plain `unique` index on bookingId; it is now a
 * partial unique index (active claims only) so a denied lead can be re-claimed.
 * Mongo does not drop the old index on a schema change, so drop it here, then
 * let syncIndexes() build the partial one.
 */
async function reconcileClaim02Indexes() {
  try {
    const coll = BdaClaim02Model.collection;
    const existing = await coll.indexes();
    const legacy = existing.find(
      (ix) => ix.name === "bookingId_1" && ix.unique && !ix.partialFilterExpression
    );
    if (legacy) {
      await coll.dropIndex("bookingId_1");
      console.log("[MongoDB] dropped legacy bda_claim02 bookingId_1 unique index");
    }
    await BdaClaim02Model.syncIndexes();
    console.log("[MongoDB] bda_claim02 indexes reconciled");
  } catch (e) {
    // Never block startup on this — worst case the old index lingers.
    console.warn("[MongoDB] bda_claim02 index reconcile skipped:", e?.message || e);
  }
}

mongoose.connection.on("connected", () => {
  console.log("[MongoDB] connected");
});

mongoose.connection.on("error", (err) => {
  console.error("[MongoDB] connection error", err);
});

mongoose.connection.on("disconnected", () => {
  console.warn("[MongoDB] disconnected — mongoose will auto-retry using bufferCommands/retry options");
});

mongoose.connection.on("reconnected", () => {
  console.log("[MongoDB] reconnected");
});

const connectWithRetry = (retryDelayMs = 5000) => {
  mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 50,
    minPoolSize: 10,
    maxIdleTimeMS: 60000,
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 45000,
    connectTimeoutMS: 15000,
    retryWrites: true,
    retryReads: true,
  })
    .then(() => {
      console.log("Database connected successfully..!");
      reconcileClaim02Indexes();
    })
    .catch((e) => {
      console.log("Problem while connecting to db", e);
      console.log(`[MongoDB] retrying connection in ${retryDelayMs / 1000}s`);
      setTimeout(() => connectWithRetry(retryDelayMs), retryDelayMs);
    });
};

const Connection = () => connectWithRetry();

export default Connection;
