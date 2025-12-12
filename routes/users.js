const express = require("express");

module.exports = (db, verifyToken, verifyAdmin) => {
  const router = express.Router();
  const usersCollection = db.collection("users");



  // GET all users (admin only)
  router.get("/", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const users = await usersCollection.find({}, { projection: { password: 0 } }).toArray();
      res.send(users);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).send({ message: "Failed to fetch users" });
    }
  });


  router.post("/", verifyToken, verifyAdmin, async (req, res) => {
    const newUser = req.body;
    if (!newUser.email || !newUser.name || !newUser.role) {
      return res.status(400).send({ message: "Name, email and role are required" });
    }

    try {
      const result = await usersCollection.insertOne(newUser);
      res.send(result);
    } catch (error) {
      console.error("Error creating user:", error);
      res.status(500).send({ message: "Failed to create user" });
    }
  });

  router.get("/user/:email", verifyToken, async (req, res) => {
    const email = req.params.email;
    const user = await usersCollection.findOne({ email });
    res.send(user);
  });

  // PATCH update user role (admin only)
  router.patch("/role", verifyToken, verifyAdmin, async (req, res) => {
    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).send({ message: "Email and new role are required" });
    }

    try {
      const query = { email: email };
      const updateDoc = {
        $set: {
          role: role
        }
      };
      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    } catch (error) {
      console.error("Error updating role:", error);
      res.status(500).send({ message: "Failed to update role" });
    }
  });

  return router;
};
