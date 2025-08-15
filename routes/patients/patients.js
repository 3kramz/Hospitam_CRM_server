const express = require("express");
const { getNextPID } = require("../../utils/counters");

module.exports = (db, verifyToken) => {
  const router = express.Router();
  const patientsCollection = db.collection("patients");
  const countersCollection = db.collection("counters");

  // Search patients
  router.get("/search", async (req, res) => {
    try {
      const q = req.query.q?.trim();
      if (!q) return res.json([]);
      const regex = new RegExp(q, "i");
      const patients = await patientsCollection
        .find({ $or: [{ name: { $regex: regex } }, { pid: { $regex: regex } }] })
        .limit(30)
        .toArray();
      res.json(patients);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to search patients" });
    }
  });

  // Save patient
  router.post("/save", verifyToken, async (req, res) => {
    try {
      const { patientInfo } = req.body;
      if (!patientInfo)
        return res.status(400).json({ success: false, error: "patientInfo is required" });

      const { name, age, gender, phone, address, email, refDoctor, pcName } = patientInfo;
      if (!name || !age || !gender || !phone || !address)
        return res.status(400).json({ success: false, error: "Missing required fields" });

      // Check if patient exists by phone
      let existingPatient = await patientsCollection.findOne({ phone });

      let pid, patientId, previousDue = 0;

      if (existingPatient) {
        // Existing patient — keep same PID
        pid = existingPatient.pid;
        patientId = existingPatient._id;
        previousDue = existingPatient.dueAmount || 0;
      } else {
        // New patient — generate new PID
        pid = await getNextPID(countersCollection);

        const newPatient = {
          pid,
          name,
          age,
          gender,
          phone,
          address: address || "",
          email: email || "",
          refDoctor: refDoctor || "",
          pcName: pcName || "",
          dueAmount: 0,
          testGroupIds: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const insertResult = await patientsCollection.insertOne(newPatient);
        patientId = insertResult.insertedId;
      }

      res.json({ success: true, patientId: patientId.toString(), pid, previousDue });
    } catch (err) {
      console.error("Error saving patient:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
