// import express from 'express';
// import Routes from "./Routes.js";
// import Connection from './Utils/ConnectDB.js'
// import cors from 'cors'

//     const app = express();

//     app.use(express.json());
//     app.use(cors());
// //routes..
//     Routes(app);
// //connection to MongoDB..
//     Connection();

//     const PORT = 8086;
//     app.listen(PORT,()=>{
//         console.log('server is live at port :', PORT);
//     })


// import express from 'express';
// import Routes from './Routes.js';
// import Connection from './Utils/ConnectDB.js';
// import cors from 'cors';

// const app = express();

// app.use(express.json());
// app.use(cors());

// // Routes
// Routes(app);

// // Connect to MongoDB
// Connection();

// // ✅ Use Render's dynamic port
// const PORT = process.env.PORT || 8086;
// app.listen(PORT, () => {
//   console.log('server is live at port :', PORT);
// });


// import express from 'express';
// import Routes from './Routes.js';
// import Connection from './Utils/ConnectDB.js';
// import cors from 'cors';
// import 'dotenv/config';

// const app = express();
// app.use(cors());
// app.use(express.json());



// app.get("/", (req, res) => {
//   res.send("FlashFire API is up and running 🚀");
// });

// // Routes
// Routes(app);

// // Connect to MongoDB
// Connection();

// // ✅ Use only Render's dynamic port (no fallback)
// const PORT = process.env.PORT;

// if (!PORT) {
//   throw new Error('❌ process.env.PORT is not set. This is required for Render deployment.');
// }

// app.listen(PORT, () => {
//   console.log('✅ Server is live at port:', PORT);
// });



import express from 'express';
import path from 'path';
import Routes from './Routes.js';
import Connection from './Utils/ConnectDB.js';
import cors from 'cors';
import 'dotenv/config';

const app = express();
app.use(cors());
app.use(express.json());

// Health-check or root API
app.get('/', (req, res) => {
  res.send('FlashFire API is up and running 🚀');
});

// Register your API endpoints
Routes(app);

// Connect to MongoDB
Connection();

// ─────── Serve React build ───────
const __dirname = path.resolve();  
// Adjust the relative path to wherever your frontend build lands
const buildPath = path.join(__dirname, '..', 'flashfire-frontend', 'build');

app.use(express.static(buildPath));

// Any GET that isn't caught by an API route or a real file → serve index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(buildPath, 'index.html'));
});
// ───────────────────────────────────

const PORT = process.env.PORT;
if (!PORT) throw new Error('❌ process.env.PORT is not set.');

app.listen(PORT, () => {
  console.log('✅ Server is live at port:', PORT);
});
