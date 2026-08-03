// import mongoose from "mongoose";
// //connection to db ..
// const Connection = () => mongoose.connect('mongodb+srv://biswajitshrm6:7DL0Lz8dxicjlXQJ@users.mt5yvfh.mongodb.net/FlashFire')
//                     .then(()=>console.log("Database connected succesfully..!"))
//                     .catch((e)=>console.log('Problem while connecting to db', e));

// export default Connection

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

console.log("[MongoDB] ConnectDB module loaded — mongo-resilience build (retry+reconnect enabled)");

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
    .then(() => console.log("Database connected successfully..!"))
    .catch((e) => {
      console.log("Problem while connecting to db", e);
      console.log(`[MongoDB] retrying connection in ${retryDelayMs / 1000}s`);
      setTimeout(() => connectWithRetry(retryDelayMs), retryDelayMs);
    });
};

const Connection = () => connectWithRetry();

export default Connection;
