// import mongoose from "mongoose";
// //connection to db ..
// const Connection = () => mongoose.connect('mongodb+srv://biswajitshrm6:7DL0Lz8dxicjlXQJ@users.mt5yvfh.mongodb.net/FlashFire')
//                     .then(()=>console.log("Database connected succesfully..!"))
//                     .catch((e)=>console.log('Problem while connecting to db', e));

// export default Connection

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const Connection = () => mongoose.connect(process.env.MONGODB_URI, {
    maxPoolSize: 20,
    minPoolSize: 5,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
  })
    .then(() => console.log("Database connected successfully..!"))
    .catch((e) => console.log('Problem while connecting to db', e));

export default Connection;
