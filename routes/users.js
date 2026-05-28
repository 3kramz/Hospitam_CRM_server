const express = require("express");
const { ObjectId } = require("mongodb");

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
    // Basic validation (allow role OR roles)
    if (!newUser.email || !newUser.name || (!newUser.role && (!newUser.roles || newUser.roles.length === 0))) {
      return res.status(400).send({ message: "Name, email and role(s) are required" });
    }

    // Normalize to arrays
    if (newUser.role && !newUser.roles) newUser.roles = [newUser.role];
    if (newUser.department && !newUser.departments) newUser.departments = [newUser.department];

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
    if (!user) {
      return res.status(404).send({ message: "User profile not found" });
    }
    res.send(user);
  });

  // PATCH update user role/access (admin only)
  router.patch("/role", verifyToken, verifyAdmin, async (req, res) => {
    // We expect { email, role?, roles?, department?, departments? }
    const { email, role, roles, department, departments } = req.body;
    if (!email) {
      return res.status(400).send({ message: "Email is required" });
    }

    try {
      const query = { email: email };
      const updateFields = {};

      if (roles) updateFields.roles = roles;
      else if (role) updateFields.roles = [role]; // Fallback if old frontend used

      if (departments) updateFields.departments = departments;
      else if (department) updateFields.departments = [department];

      // Also update single fields for potential backward compat if needed (optional)
      if (role) updateFields.role = role;
      if (department) updateFields.department = department;

      const updateDoc = {
        $set: updateFields
      };

      const result = await usersCollection.updateOne(query, updateDoc);
      res.send(result);
    } catch (error) {
      console.error("Error updating user access:", error);
      res.status(500).send({ message: "Failed to update user access" });
    }
  });

  // DELETE user (admin only)
  router.delete("/:id", verifyToken, verifyAdmin, async (req, res) => {
    const id = req.params.id;
    try {
      const query = { _id: new ObjectId(id) };
      const result = await usersCollection.deleteOne(query);
      res.send(result);
    } catch (error) {
      console.error("Error deleting user:", error);
      res.status(500).send({ message: "Failed to delete user" });
    }
  });

  return router;
};
