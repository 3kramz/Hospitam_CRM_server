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

  app.use("/jwt", jwtRouter);
  app.use("/", base);
  app.use("/users", users);

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

startServer();