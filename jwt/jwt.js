const express = require("express");
const jwt = require("jsonwebtoken");

module.exports = (db) => {
  const router = express.Router();
  const usersCollection = db.collection("users");
  const jwtSecret = process.env.ACCESS_TOKEN;

  if (!jwtSecret) {
    throw new Error("ACCESS_TOKEN environment variable is required");
  }

  // ─── Generate Token ───────────────────────────────────────────────────────
  // Also returns the user profile so the client doesn't need a second
  // GET /users/user/:email round-trip immediately after login.
  router.post("/", async (req, res) => {
    const user = req.body;

    if (!user || !user.email) {
      return res.status(400).send({ message: "Invalid user data" });
    }

    try {
      const dbUser = await usersCollection.findOne({ email: user.email });
      const roles = dbUser?.roles || (dbUser?.role ? [dbUser.role] : []);

      // Block token issuance for unknown / non-onboarded staff.
      if (!dbUser || roles.length === 0) {
        return res.status(403).send({ message: "User is not authorized for CRM access" });
      }

      const tokenPayload = {
        email: user.email,
        roles,
        departments: dbUser?.departments || (dbUser?.department ? [dbUser.department] : []),
      };

      const token = jwt.sign(tokenPayload, jwtSecret, { expiresIn: "1h" });

      // Strip sensitive fields before sending user back to client
      const { password, ...safeUser } = dbUser;
      res.send({ token, user: safeUser });
    } catch (err) {
      console.error("JWT Sign Error:", err);
      res.status(500).send({ message: "Failed to generate token" });
    }
  });

  // ─── Verify Token Middleware ──────────────────────────────────────────────
  const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).send({ message: "Unauthorized access: no token" });
    }

    const token = authHeader.split(" ")[1];

    jwt.verify(token, jwtSecret, (err, decoded) => {
      if (err) {
        console.error("JWT Verify Error:", err);
        return res.status(401).send({
          message: "Unauthorized access: invalid token",
          error: err.message,
        });
      }
      req.decoded = decoded;
      next();
    });
  };

  // ─── Role Middlewares (synchronous — roles are already in the JWT) ────────
  // Previously these each did a MongoDB findOne() on every request.
  // The JWT payload already contains roles (set at token generation time),
  // so we can read req.decoded.roles directly — zero extra DB round-trips.

  const verifyAdmin = (req, res, next) => {
    const roles = req.decoded?.roles || [];
    if (!roles.includes("admin")) {
      return res.status(403).send({ message: "Forbidden access: not an admin" });
    }
    next();
  };

  const verifyLabExpert = (req, res, next) => {
    const roles = req.decoded?.roles || [];
    if (!roles.includes("lab_expert") && !roles.includes("admin")) {
      return res.status(403).send({ message: "Forbidden access: not a lab expert" });
    }
    next();
  };

  const verifyFrontDesk = (req, res, next) => {
    const roles = req.decoded?.roles || [];
    if (!roles.includes("front_desk") && !roles.includes("admin")) {
      return res.status(403).send({ message: "Forbidden access: not front desk" });
    }
    next();
  };

  const verifySampleCollection = (req, res, next) => {
    const roles = req.decoded?.roles || [];
    if (!roles.includes("sample_collection") && !roles.includes("admin")) {
      return res.status(403).send({ message: "Forbidden access: not sample collection" });
    }
    next();
  };

  const verifyLabAccess = (req, res, next) => {
    const roles = req.decoded?.roles || [];
    if (
      !roles.includes("lab_expert") &&
      !roles.includes("sample_collection") &&
      !roles.includes("admin")
    ) {
      return res.status(403).send({ message: "Forbidden access: not authorized for lab board" });
    }
    next();
  };

  return {
    jwtRouter: router,
    verifyToken,
    verifyAdmin,
    verifyLabExpert,
    verifyFrontDesk,
    verifySampleCollection,
    verifyLabAccess,
  };
};
