const express = require("express");
const { ObjectId } = require("mongodb");
const { getNextPID } = require("../../utils/counters");

module.exports = (db, verifyToken) => {
  const router = express.Router();
  const patientsCollection = db.collection("patients");
  const testGroupsCollection = db.collection("testGroups");



  // /save-patient-bill
router.post("/", verifyToken, async (req, res) => {
    try {
      const { patientInfo, tests, discounts, payment, grandTotal } = req.body;
      if (!tests || !tests.length) {
        return res.status(400).json({ success: false, error: "No tests selected" });
      }

      let patient = await patientsCollection.findOne({ pid: patientInfo.pid });

      if (!patient) {
        // Create new patient if not found
        const pid = await getNextPID(countersCollection);
        const newPatient = {
          pid,
          name: patientInfo.name,
          age: patientInfo.age,
          gender: patientInfo.gender,
          phone: patientInfo.phone,
          address: patientInfo.address || "",
          email: patientInfo.email || "",
          refDoctor: patientInfo.refDoctor || "",
          pcName: patientInfo.pcName || "",
          dueAmount: 0,
          testGroupIds: [],
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        const insertResult = await patientsCollection.insertOne(newPatient);
        patient = { ...newPatient, _id: insertResult.insertedId };
      }

      const updatedDue = (patient.dueAmount || 0) + grandTotal - (payment || 0);

      const testGroupDoc = {
        patientId: patient._id,
        pid: patient.pid,
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

      await patientsCollection.updateOne(
        { _id: patient._id },
        { $push: { testGroupIds: groupId }, $set: { dueAmount: updatedDue, updatedAt: new Date() } }
      );

      res.json({
        success: true,
        patientId: patient._id.toString(),
        pid: patient.pid,
        groupId: groupId.toString(),
      });
    } catch (err) {
      console.error("Save bill error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });


router.get("/all-reports", verifyToken, async (req, res) => {

  try {
    const testGroups = await testGroupsCollection
      .find({})
      .sort({ createdAt: -1 }) // latest first
      .toArray();
      
    const reports = await Promise.all(
      testGroups.map(async (group) => {
        const patient = await patientsCollection.findOne({ _id: new ObjectId(group.patientId) });
        if (!patient) return null;

        // Calculate totals
        const total = group.tests.reduce((sum, t) => sum + (t.price || 0), 0);
        const discount = group.tests.reduce((sum, t) => sum + (t.discount || 0), 0);
        const netTotal = total - discount;
        const payment = group.payment || 0;

        return {
          id: group._id.toString(),
          invoiceId: group._id.toString().slice(-8), // last 6 chars as Invoice ID
          patientId: patient.pid,
          patientName: patient.name,
          address:patient.address,
          total: total,
          discount: discount,
          vat: 0,
          payment: payment,
          status: payment >= netTotal ? "PAID" : "DUE",
          createdAt: group.createdAt,
        };
      })
    );

    res.json(reports.filter(r => r !== null));
  } catch (err) {
    console.error("Error fetching all reports:", err);
    res.status(500).json({ error: "Server error" });
  }
});

    router.get("/:groupId", async (req, res) => {
   
    try {
      const groupId = req.params.groupId;
      if (!ObjectId.isValid(groupId)) {
        return res.status(400).json({ error: "Invalid groupId" });
      }

      const testGroup = await testGroupsCollection.findOne({ _id: new ObjectId(groupId) });
      if (!testGroup) {
        return res.status(404).json({ error: "Test group not found" });
      }

      // Fetch patient info for this group
      const patient = await patientsCollection.findOne({ _id: new ObjectId(testGroup.patientId) });
      if (!patient) {
        return res.status(404).json({ error: "Patient not found" });
      }

      // Prepare response data
      const response = {
        ...testGroup,
        patientInfo: {
          pid: patient.pid,
          name: patient.name,
          age: patient.age,
          gender: patient.gender,
          address:patient.address,
          email:patient.email,
          phone: patient.phone,
          refDoctor: patient.refDoctor,
          pcName: patient.pcName,
          dueAmount: patient.dueAmount,
        },
        previousDue: patient.dueAmount || 0,
        totalDiscount: testGroup.tests.reduce((sum, t) => sum + (t.discount || 0), 0),
        vat: 0, // if you add VAT later, calculate here
      };

      res.json(response);
    } catch (err) {
      console.error("Error fetching invoice data:", err);
      res.status(500).json({ error: "Server error" });
    }
  });
  return router;
};
