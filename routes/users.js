const express = require("express");

module.exports = (db, verifyToken, verifyAdmin) => {
  const router = express.Router();
  const usersCollection = db.collection("users");



  router.get("/user/:email",verifyToken, async (req, res) => {
    const email = req.params.email;
    const user = await usersCollection.findOne({ email });
    res.send(user);
  });



  return router;
};
