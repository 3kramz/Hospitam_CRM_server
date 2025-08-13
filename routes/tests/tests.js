const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");

module.exports = (db, verifyToken) => {
  const patientsCollection = db.collection("patients");
  const testGroupsCollection = db.collection("testGroups"); // new collection for grouped tests
  const countersCollection = db.collection("counters");

  // Get next sequential patient ID (p001, p002...)
  async function getNextPID() {
    const result = await countersCollection.findOneAndUpdate(
      { _id: "patientId" },
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" }
    );

    const doc = result.value || result;
    if (!doc || typeof doc.seq !== "number") {
      throw new Error("Failed to get counter document");
    }
    return `p${doc.seq.toString().padStart(3, "0")}`;
  }

  router.post("/", verifyToken, async (req, res) => {
    try {
      const {
        patientInfo,
        tests,
        discounts,
        payment,
        updatedDue,
        grandTotal,
      } = req.body;

      let patientId;
      let pid;

      // 1️⃣ Check for existing patient
      let existingPatient = null;
      if (patientInfo.phone && patientInfo.gender && patientInfo.name) {
        existingPatient = await patientsCollection.findOne({
          phone: patientInfo.phone,
          gender: patientInfo.gender,
          name: patientInfo.name,
        });
      }

      // 2️⃣ Create new patient if not found
      if (!existingPatient) {
        pid = await getNextPID();
        const newPatient = {
          pid,
          name: patientInfo.name,
          age: patientInfo.age,
          gender: patientInfo.gender,
          phone: patientInfo.phone || "",
          refDoctor: patientInfo.refDoctor || "",
          pcName: patientInfo.pcName || "",
          dueAmount: updatedDue,
          createdAt: new Date(),
          updatedAt: new Date(),
          testGroupIds: [], // store group IDs instead of individual tests
        };
        const insertResult = await patientsCollection.insertOne(newPatient);
        patientId = insertResult.insertedId;
      } else {
        patientId = existingPatient._id;
        pid = existingPatient.pid;
        await patientsCollection.updateOne(
          { _id: patientId },
          { $set: { dueAmount: updatedDue, updatedAt: new Date() } }
        );
      }

      // 3️⃣ Create a grouped test entry for this visit
      const testGroupDoc = {
        patientId,
        pid,
        tests: tests.map((t) => ({
          test_id: t.test_id,
          testName: t.name,
          price: t.price,
          discount: discounts[t.test_id] || 0,
          netAmount: t.price - (discounts[t.test_id] || 0),
        })),
        payment,
        grandTotal,
        createdAt: new Date(),
      };

      const groupInsertResult = await testGroupsCollection.insertOne(testGroupDoc);
      const groupId = groupInsertResult.insertedId;

      // 4️⃣ Add this groupId to patient's testGroupIds array
      await patientsCollection.updateOne(
        { _id: patientId },
        { $push: { testGroupIds: groupId }, $set: { updatedAt: new Date() } }
      );

      res.json({
        success: true,
        patientId: patientId.toString(),
        pid,
        groupId: groupId.toString(),
      });
    } catch (err) {
      console.error("Save bill error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};