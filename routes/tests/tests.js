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
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const search = req.query.search || "";
      const statusFilter = req.query.status || "";
      const paymentFilter = req.query.payment || "";
      const skip = (page - 1) * limit;


      const pipeline = [
        {
          $lookup: {
            from: "patients",
            localField: "patientId",
            foreignField: "_id",
            as: "patientInfo"
          }
        },
        { $unwind: { path: "$patientInfo", preserveNullAndEmptyArrays: true } },

        {
          $addFields: {
            totalAmount: { $sum: "$tests.price" },
            totalDiscount: { $sum: "$tests.discount" },
          }
        },
        {
          $addFields: {
            netAmount: { $subtract: ["$totalAmount", "$totalDiscount"] }
          }
        },
        {
          $addFields: {
            paymentStatus: {
              $cond: { if: { $gte: ["$payment", "$netAmount"] }, then: "PAID", else: "DUE" }
            },
            isPaid: { $gt: ["$payment", 0] }
          }
        }
      ];

      // 2. Build Match Object
      let matchQuery = {};

      if (search) {
        const regex = { $regex: search, $options: "i" };
        matchQuery.$or = [
          { "patientInfo.name": regex },
          { "patientInfo.pid": regex },
          { "patientInfo.phone": regex },
        ];
      }

      if (statusFilter) {
        matchQuery.paymentStatus = statusFilter.toUpperCase();
      }

      if (paymentFilter) {
        if (paymentFilter === 'paid') {
          matchQuery.payment = { $gt: 0 };
        } else if (paymentFilter === 'unpaid') {
          matchQuery.payment = { $eq: 0 };
        }
      }

      if (Object.keys(matchQuery).length > 0) {
        pipeline.push({ $match: matchQuery });
      }

      // 3. Sort
      pipeline.push({ $sort: { createdAt: -1 } });

      // 4. Facet
      pipeline.push({
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            { $skip: skip },
            { $limit: limit },
            {
              $project: {
                _id: 1,
                id: { $toString: "$_id" },
                invoiceId: { $substr: [{ $toString: "$_id" }, 16, 8] },
                patientId: { $ifNull: ["$patientInfo.pid", "N/A"] },
                patientName: { $ifNull: ["$patientInfo.name", "Unknown"] },
                address: { $ifNull: ["$patientInfo.address", ""] },
                contact: { $ifNull: ["$patientInfo.phone", ""] },
                totalDue: { $subtract: ["$netAmount", "$payment"] },
                payment: 1,
                status: "$paymentStatus",
                createdAt: 1
              }
            }
          ]
        }
      });


      const results = await testGroupsCollection.aggregate(pipeline).toArray();

      const data = results[0].data;
      const totalCount = results[0].metadata[0] ? results[0].metadata[0].total : 0;

      res.json({
        reports: data,
        totalCount: totalCount,
        currentPage: page,
        totalPages: Math.ceil(totalCount / limit)
      });

    } catch (err) {
      console.error("Error fetching reports:", err);
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

      const patient = await patientsCollection.findOne({ _id: new ObjectId(testGroup.patientId) });
      if (!patient) {
        return res.status(404).json({ error: "Patient not found" });
      }

      const response = {
        ...testGroup,
        patientInfo: {
          pid: patient.pid,
          name: patient.name,
          age: patient.age,
          gender: patient.gender,
          address: patient.address,
          email: patient.email,
          phone: patient.phone,
          refDoctor: patient.refDoctor,
          pcName: patient.pcName,
          dueAmount: patient.dueAmount,
        },
        previousDue: patient.dueAmount || 0,
        totalDiscount: testGroup.tests.reduce((sum, t) => sum + (t.discount || 0), 0),
        vat: 0,
      };

      res.json(response);
    } catch (err) {
      console.error("Error fetching invoice data:", err);
      res.status(500).json({ error: "Server error" });
    }
  });
  return router;
};
