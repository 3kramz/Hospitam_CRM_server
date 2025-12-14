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
      const secret = process.env.ACCESS_TOKEN || "temporary_secret";
      const token = jwt.sign(user, secret, {
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

    require("dotenv").config();
    const secret = process.env.ACCESS_TOKEN || "temporary_secret";
    jwt.verify(token, secret, (err, decoded) => {
      if (err) {
        console.error("JWT Verify Error:", err);
        return res.status(401).send({
          message: "Unauthorized access: invalid token",
          error: err.message,
          secretExists: !!process.env.ACCESS_TOKEN
        });
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
      const roles = user?.roles || (user?.role ? [user.role] : []);
      if (!roles.includes("admin")) {
        return res.status(403).send({ message: "Forbidden access: not an admin" });
      }
      next();
    } catch (err) {
      console.error("Admin check failed:", err);
      res.status(500).send({ message: "Server error" });
    }
  };

  // Verify Lab Expert Middleware
  const verifyLabExpert = async (req, res, next) => {
    const email = req.decoded?.email;
    if (!email) {
      return res.status(403).send({ message: "Forbidden access: no email in token" });
    }

    try {
      const user = await usersCollection.findOne({ email });
      const roles = user?.roles || (user?.role ? [user.role] : []);
      if (!roles.includes("lab_expert") && !roles.includes("admin")) {
        return res.status(403).send({ message: "Forbidden access: not a lab expert" });
      }
      next();
    } catch (err) {
      console.error("Lab Expert check failed:", err);
      res.status(500).send({ message: "Server error" });
    }
  };
  // Verify Front Desk Middleware
  const verifyFrontDesk = async (req, res, next) => {
    const email = req.decoded?.email;
    if (!email) {
      return res.status(403).send({ message: "Forbidden access: no email in token" });
    }
    try {
      const user = await usersCollection.findOne({ email });
      const roles = user?.roles || (user?.role ? [user.role] : []);
      if (!roles.includes("front_desk") && !roles.includes("admin")) {
        return res.status(403).send({ message: "Forbidden access: not front desk" });
      }
      next();
    } catch (err) {
      console.error("Front Desk check failed:", err);
      res.status(500).send({ message: "Server error" });
    }
  };

  // Verify Sample Collection Middleware
  const verifySampleCollection = async (req, res, next) => {
    const email = req.decoded?.email;
    if (!email) {
      return res.status(403).send({ message: "Forbidden access: no email in token" });
    }
    try {
      const user = await usersCollection.findOne({ email });
      const roles = user?.roles || (user?.role ? [user.role] : []);
      if (!roles.includes("sample_collection") && !roles.includes("admin")) {
        return res.status(403).send({ message: "Forbidden access: not sample collection" });
      }
      next();
    } catch (err) {
      console.error("Sample Collection check failed:", err);
      res.status(500).send({ message: "Server error" });
    }
  };

  // Verify Lab Access (Lab Expert OR Sample Collection)
  const verifyLabAccess = async (req, res, next) => {
    const email = req.decoded?.email;
    if (!email) {
      return res.status(403).send({ message: "Forbidden access: no email in token" });
    }
    try {
      const user = await usersCollection.findOne({ email });
      if (!user) {
        // User not found, but we let it fall through to roles check which will likely fail or be empty
      }

      const roles = user?.roles || (user?.role ? [user.role] : []);

      if (!roles.includes("lab_expert") && !roles.includes("sample_collection") && !roles.includes("admin")) {
        return res.status(403).send({ message: "Forbidden access: not authorized for lab board" });
      }
      next();
    } catch (err) {
      console.error("Lab Access check failed:", err);
      res.status(500).send({ message: "Server error" });
    }
  };

  return {
    jwtRouter: router,
    verifyToken,
    verifyAdmin,
    verifyLabExpert,
    verifyFrontDesk,
    verifySampleCollection,
    verifyLabAccess
  };
};
