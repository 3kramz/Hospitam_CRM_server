const express = require("express");
const { ObjectId } = require("mongodb");
const { getNextPID, getNextInvoiceID } = require("../../utils/counters");

module.exports = (db, verifyToken, verifyLabExpert) => {
  const router = express.Router();
  const patientsCollection = db.collection("patients");
  const testGroupsCollection = db.collection("testGroups");
  const testsCollection = db.collection("tests");
  const countersCollection = db.collection("counters");

  // Get all tests from the master list
  router.get("/test-list", verifyToken, async (req, res) => {
    try {
      const tests = await testsCollection.find({}).toArray();
      res.json(tests);
    } catch (err) {
      console.error("Error fetching test list:", err);
      res.status(500).json({ error: "Failed to fetch tests" });
    }
  });



  // /save-patient-bill
  router.post("/", verifyToken, async (req, res) => {
    try {
      const { patientInfo, tests, discounts, payment, grandTotal } = req.body;
      if ((!tests || !tests.length) && (!payment || payment <= 0)) {
        return res.status(400).json({ success: false, error: "No tests selected and no payment made." });
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
      const updatedDue = grandTotal - (payment || 0);

      const invoiceId = await getNextInvoiceID(countersCollection);

      const testGroupDoc = {
        invoiceId,
        patientId: patient._id,
        pid: patient.pid,
        tests: tests.map((t) => ({
          test_id: t.test_id,
          testName: t.name,
          price: t.price,
          discount: discounts[t.test_id] || 0,
          netAmount: t.price - (discounts[t.test_id] || 0),
          status: 'assigned', // assigned, test_running, complete
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
      const testStatusFilter = req.query.testStatus || ""; // New filter
      const skip = (page - 1) * limit;


      const sortField = req.query.sort || "createdAt";
      const sortOrder = req.query.order === "asc" ? 1 : -1;

      // Map frontend keys to backend fields
      const sortMapping = {
        invoiceId: "_id",
        patientId: "patientInfo.pid",
        patientName: "patientInfo.name",
        address: "patientInfo.address",
        contact: "patientInfo.phone",
        payment: "payment",
        totalDue: "totalDue",
        status: "paymentStatus",
        testStatus: "computedTestStatus", // Sort by new field
        createdAt: "createdAt"
      };

      const sortKey = sortMapping[sortField] || "createdAt";

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
            isPaid: { $gt: ["$payment", 0] },
            totalDue: { $subtract: ["$netAmount", "$payment"] },
            // Calculate Test Status Logic
            computedTestStatus: {
              $switch: {
                branches: [
                  // If tests array is empty, maybe assigned or pending? defaulting to assigned.
                  // If all tests are complete
                  {
                    case: {
                      $and: [
                        { $gt: [{ $size: { $ifNull: ["$tests", []] } }, 0] },
                        { $eq: [{ $size: { $filter: { input: "$tests", cond: { $ne: ["$$this.status", "complete"] } } } }, 0] }
                      ]
                    },
                    then: "Complete"
                  },
                  // If any test is running
                  {
                    case: { $in: ["test_running", { $ifNull: ["$tests.status", []] }] },
                    then: "Running"
                  }
                ],
                default: "Assigned"
              }
            }
          }
        },
        // Match Object Logic (moved inside pipeline dynamically if not empty but we can build it first)
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

      if (testStatusFilter) {
        // Assuming filter comes as "Complete", "Running", "Assigned" (case insensitive optional but strict for now)
        matchQuery.computedTestStatus = { $regex: new RegExp(`^${testStatusFilter}$`, "i") };
      }

      if (paymentFilter) {
        if (paymentFilter === 'paid') {
          matchQuery.payment = { $gt: 0 };
        } else if (paymentFilter === 'unpaid') {
          matchQuery.payment = { $eq: 0 };
        }
      }

      const startDate = req.query.startDate;
      const endDate = req.query.endDate;

      if (startDate || endDate) {
        matchQuery.createdAt = {};
        if (startDate) {
          matchQuery.createdAt.$gte = new Date(startDate);
        }
        if (endDate) {
          // Set end date to end of day
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          matchQuery.createdAt.$lte = end;
        }
      }

      if (Object.keys(matchQuery).length > 0) {
        pipeline.push({ $match: matchQuery });
      }

      // 3. Sort
      pipeline.push({ $sort: { [sortKey]: sortOrder } });

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
                invoiceId: { $ifNull: ["$invoiceId", { $substr: [{ $toString: "$_id" }, 16, 8] }] },
                patientId: { $ifNull: ["$patientInfo.pid", "N/A"] },
                patientName: { $ifNull: ["$patientInfo.name", "Unknown"] },
                address: { $ifNull: ["$patientInfo.address", ""] },
                contact: { $ifNull: ["$patientInfo.phone", ""] },
                totalDue: 1, // Already calculated
                payment: 1,
                status: "$paymentStatus",
                createdAt: 1,
                testStatus: "$computedTestStatus" // Use the pre-calculated status
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



  // Statistics Endpoint
  router.get("/stats", verifyToken, async (req, res) => {
    try {
      console.log("Fetching stats...");
      const stats = await testGroupsCollection.aggregate([
        { $unwind: "$tests" },
        {
          $group: {
            _id: null,
            totalTests: { $sum: 1 },
            totalCompleted: {
              $sum: {
                $cond: [{ $eq: [{ $toLower: { $ifNull: ["$tests.status", ""] } }, "complete"] }, 1, 0]
              }
            },
            totalRunning: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: [{ $toLower: { $ifNull: ["$tests.status", ""] } }, "running"] },
                      { $eq: [{ $toLower: { $ifNull: ["$tests.status", ""] } }, "test_running"] }
                    ]
                  },
                  1,
                  0
                ]
              }
            },
            totalAssigned: {
              $sum: {
                $cond: [
                  {
                    $or: [
                      { $eq: [{ $toLower: { $ifNull: ["$tests.status", ""] } }, "assigned"] },
                      { $eq: ["$tests.status", null] }, // Handle missing status as assigned
                      { $eq: ["$tests.status", ""] }
                    ]
                  },
                  1,
                  0
                ]
              }
            }
          }
        },
        {
          $project: {
            _id: 0,
            totalTests: 1,
            totalCompleted: 1,
            totalRunning: 1,
            totalAssigned: 1
          }
        }
      ]).toArray();

      const result = stats[0] || {
        totalTests: 0,
        totalCompleted: 0,
        totalRunning: 0,
        totalAssigned: 0
      };

      console.log("Stats computed:", result);
      res.json(result);
    } catch (err) {
      console.error("Error fetching stats:", err);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });


  // Get all tests for Lab Expert (Lab Queue)
  router.get("/lab-queue", verifyToken, verifyLabExpert, async (req, res) => {
    try {
      const { status, search } = req.query; // status can be comma separated: "assigned,test_running"

      let statusFilter = {};
      if (status) {
        const statuses = status.split(',');
        if (statuses.length > 1) {
          statusFilter = { "tests.status": { $in: statuses } };
        } else {
          // Handle single status or "assigned" special case (legacy support)
          if (status === "assigned") {
            statusFilter = {
              $or: [
                { "tests.status": "assigned" },
                { "tests.status": { $exists: false } },
                { "tests.status": null }
              ]
            };
          } else {
            statusFilter = { "tests.status": status };
          }
        }
      }

      const pipeline = [
        { $unwind: "$tests" },
        // Match stage
        ...(status
          ? [
            {
              $match: statusFilter
            },
          ]
          : []),

        // Lookup Patient Info EARLY to allow searching by patient details
        {
          $lookup: {
            from: "patients",
            localField: "patientId",
            foreignField: "_id",
            as: "patientInfo"
          }
        },
        { $unwind: "$patientInfo" },

        // Add fields for search (Invoice ID is string of _id)
        { $addFields: { invoiceIdStr: { $toString: "$_id" } } },

        // Search Match (Enhanced & Safe)
        ...(search ? (() => {
          const escapeRegex = (text) => text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
          const terms = search.split(/\s+/).filter(t => t.trim());

          if (terms.length === 0) return [];

          return [{
            $match: {
              $and: terms.map(term => ({
                $or: [
                  { invoiceIdStr: { $regex: escapeRegex(term), $options: "i" } },
                  { "patientInfo.name": { $regex: escapeRegex(term), $options: "i" } },
                  { "patientInfo.pid": { $regex: escapeRegex(term), $options: "i" } },
                  { "tests.testName": { $regex: escapeRegex(term), $options: "i" } }
                ]
              }))
            }
          }];
        })() : []),

        // Sorting (oldest first for queue usually, or newest)
        { $sort: { createdAt: -1 } },

        // Project necessary fields
        {
          $project: {
            _id: 1, // distinct test group id
            testIndex: 1,
            uniqueTestInstanceId: { $concat: [{ $toString: "$_id" }, "_", { $toString: "$tests.test_id" }] }, // Pseudo-ID for frontend list keys
            patientName: "$patientInfo.name",
            patientId: "$patientInfo._id", // Added for linking
            pid: "$patientInfo.pid",
            age: "$patientInfo.age",
            gender: "$patientInfo.gender",
            testName: "$tests.testName",
            testId: "$tests.test_id", // The generic test ID
            status: "$tests.status",
            price: "$tests.price",
            date: "$createdAt",
            invoiceIdStr: 1
          }
        }
      ];

      const queue = await testGroupsCollection.aggregate(pipeline).toArray();
      res.json(queue);

    } catch (err) {
      console.error("Error fetching lab queue:", err);
      res.status(500).json({ error: "Failed to fetch lab queue" });
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
        previousDue: testGroup.grandTotal - (testGroup.tests.reduce((sum, t) => sum + (t.price - (t.discount || 0)), 0)) || 0,
        totalDiscount: testGroup.tests.reduce((sum, t) => sum + (t.discount || 0), 0),
        vat: 0,
      };

      res.json(response);
    } catch (err) {
      console.error("Error fetching invoice data:", err);
      res.status(500).json({ error: "Server error" });
    }
  });

  // Update Test Status
  router.patch("/status", verifyToken, verifyLabExpert, async (req, res) => {
    const { groupId, testId, status } = req.body;

    if (!groupId || !testId || !status) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {

      const result = await testGroupsCollection.updateOne(
        { _id: new ObjectId(groupId), "tests.test_id": testId },
        {
          $set: { "tests.$.status": status }
        }
      );

      if (result.modifiedCount === 0) {
        return res.status(404).json({ error: "Test not found or status already set" });
      }

      res.json({ success: true, message: "Status updated" });
    } catch (err) {
      console.error("Error updating test status:", err);
      res.status(500).json({ error: "Failed to update status" });
    }
  });

  return router;
};
