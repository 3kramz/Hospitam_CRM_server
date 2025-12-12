const express = require("express");
const { getNextPID } = require("../../utils/counters");

module.exports = (db, verifyToken) => {
  const router = express.Router();
  const patientsCollection = db.collection("patients");
  const countersCollection = db.collection("counters");

  // Get all patients with pagination
  router.get("/all", verifyToken, async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 20;
      const skip = (page - 1) * limit;
      const search = req.query.search || "";

      let query = {};
      if (search) {
        const regex = new RegExp(search, "i");
        query = { $or: [{ name: regex }, { phone: regex }, { pid: regex }] };
      }

      const total = await patientsCollection.countDocuments(query);
      const patients = await patientsCollection
        .find(query)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .toArray();

      res.json({
        patients,
        total,
        page,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error("Error fetching all patients:", err);
      res.status(500).json({ error: "Failed to fetch patients" });
    }
  });

  // Get patient history
  router.get("/:pid/history", verifyToken, async (req, res) => {
    try {
      const { pid } = req.params;
      const patient = await patientsCollection.findOne({ pid });

      if (!patient) {
        return res.status(404).json({ error: "Patient not found" });
      }

      const history = await db.collection("testGroups")
        .find({ pid: pid })
        .sort({ createdAt: -1 })
        .toArray();

      res.json({ patient, history });
    } catch (err) {
      console.error("Error fetching patient history:", err);
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

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

      // Check if patient exists by PID (strongest match) or Phone
      let existingPatient = null;
      if (patientInfo.pid) {
        existingPatient = await patientsCollection.findOne({ pid: patientInfo.pid });
      }

      if (!existingPatient && phone) {
        existingPatient = await patientsCollection.findOne({ phone });
      }

      let pid, patientId, previousDue = 0;

      if (existingPatient) {
        // Existing patient — keep same PID
        pid = existingPatient.pid;
        patientId = existingPatient._id;
        previousDue = existingPatient.dueAmount || 0;

        // Update existing patient info
        await patientsCollection.updateOne(
          { _id: existingPatient._id },
          {
            $set: {
              name,
              age,
              gender,
              phone,
              address: address || "",
              email: email || "",
              refDoctor: refDoctor || "",
              pcName: pcName || "",
              updatedAt: new Date()
            }
          }
        );
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
