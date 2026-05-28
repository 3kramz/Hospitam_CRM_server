const express = require("express");

module.exports = (db, verifyToken) => {
  const router = express.Router();
  const doctorsCollection = db.collection("doctors");

  router.get("/search", verifyToken, async (req, res) => {
    try {
      const q = req.query.q?.trim();
      if (!q) return res.json([]);

      const regex = new RegExp(q, "i");

      const doctors = await doctorsCollection
        .find({ name: { $regex: regex } })
        .limit(20)
        .toArray();

      res.json(doctors);
    } catch (err) {
      console.error("Error searching doctors:", err);
      res.status(500).json({ error: "Failed to search doctors" });
    }
  });

  return router;
};
