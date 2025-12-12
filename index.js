const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const connectDB = require("./config/db");
const jwtModule = require("./jwt/jwt");

dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());

async function startServer() {
  const db = await connectDB();

  const { jwtRouter, verifyToken, verifyAdmin } = jwtModule(db);

  const base = require("./routes/base")(db, verifyToken);
  const users = require("./routes/users")(db, verifyToken, verifyAdmin);
  const patients = require("./routes/patients/patients")(db, verifyToken);
  const doctors = require("./routes/doctors/doctors")(db, verifyToken);
  const tests = require("./routes/tests/tests")(db, verifyToken);

  app.use("/", base);
  app.use("/jwt", jwtRouter);
  app.use("/users", users);
  app.use("/patients", patients);
  app.use("/doctors", doctors);
  app.use("/save-patient-bill", tests)

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

startServer();