const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/db");
const jwtModule = require("./jwt/jwt");

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

let db;
let routesInitialized = false;

async function initializeRoutes() {
  if (routesInitialized) return;

  try {
    db = await connectDB();
    const { jwtRouter, verifyToken, verifyAdmin, verifyLabExpert, verifyFrontDesk, verifySampleCollection, verifyLabAccess } = jwtModule(db);

    const base = require("./routes/base")(db, verifyToken);
    const users = require("./routes/users")(db, verifyToken, verifyAdmin);
    const patients = require("./routes/patients/patients")(db, verifyToken, verifyFrontDesk);
    const doctors = require("./routes/doctors/doctors")(db, verifyToken);
    const tests = require("./routes/tests/tests")(db, verifyToken, verifyLabExpert, verifyFrontDesk, verifySampleCollection, verifyAdmin, verifyLabAccess);

    app.use("/", base);
    app.use("/jwt", jwtRouter);
    app.use("/users", users);
    app.use("/patients", patients);
    app.use("/doctors", doctors);
    app.use("/tests", tests);

    routesInitialized = true;
  } catch (error) {
    console.error("Failed to initialize routes:", error);
    throw error;
  }
}

// Vercel Serverless Handler
module.exports = async (req, res) => {
  await initializeRoutes();
  return app(req, res);
};

// Local Development
if (require.main === module) {
  initializeRoutes().then(() => {
    const PORT = process.env.PORT || 5000;
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  });
}