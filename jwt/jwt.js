const express = require("express");
const jwt = require("jsonwebtoken");

module.exports = (db) => {
  const router = express.Router();
  const usersCollection = db.collection("users");

  // Generate Token
  router.post("/", async (req, res) => {
    const user = req.body;

    if (!user || !user.email) {
      return res.status(400).send({ message: "Invalid user data" });
    }

    try {
      const token = jwt.sign(user, process.env.ACCESS_TOKEN, {
        expiresIn: "1h",
      });
      res.send({ token });
    } catch (err) {
      console.error("JWT Sign Error:", err);
      res.status(500).send({ message: "Failed to generate token" });
    }
  });

  // Verify Token Middleware
  const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send({ message: "Unauthorized access: no token" });
    }

    const token = authHeader.split(" ")[1];

    jwt.verify(token, process.env.ACCESS_TOKEN, (err, decoded) => {
      if (err) {
        console.error("JWT Verify Error:", err);
        return res.status(401).send({ message: "Unauthorized access: invalid token" });
      }
      req.decoded = decoded;
      next();
    });
  };

  // Verify Admin Middleware
  const verifyAdmin = async (req, res, next) => {
    const email = req.decoded?.email;
    if (!email) {
      return res.status(403).send({ message: "Forbidden access: no email in token" });
    }

    try {
      const user = await usersCollection.findOne({ email });
      if (user?.role !== "admin") {
        return res.status(403).send({ message: "Forbidden access: not an admin" });
      }
      next();
    } catch (err) {
      console.error("Admin check failed:", err);
      res.status(500).send({ message: "Server error" });
    }
  };

  return {
    jwtRouter: router,
    verifyToken,
    verifyAdmin,
  };
};
