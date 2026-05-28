const express = require("express");

module.exports = (db, verifyToken) => {
  const router = express.Router();
  router.get("/", async (req, res) => {
    try {
    
      res.json({ data: "Hospital CRM" });
    } catch (err) {
      res.status(500).json({ message: "Server error" });
    }
  });
  

  return router;
};
