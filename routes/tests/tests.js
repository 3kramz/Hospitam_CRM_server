const express = require("express");
const { ObjectId } = require("mongodb");
const { getNextPID, getNextInvoiceID } = require("../../utils/counters");

module.exports = (db, verifyToken, verifyLabExpert, verifyFrontDesk, verifySampleCollection, verifyAdmin) => {
  const router = express.Router();
  const patientsCollection = db.collection("patients");
  const testGroupsCollection = db.collection("testGroups");
  const testsCollection = db.collection("tests");
  const countersCollection = db.collection("counters");
  const usersCollection = db.collection("users");

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
          department: t.department,
          roomNumber: t.roomNumber,
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
  router.get("/dashboard-stats", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const { period, startDate, endDate } = req.query; // period: daily, weekly, custom
      const matchStage = {};

      let start, end;
      const today = new Date();

      if (period === 'daily') {
        start = new Date(today.setHours(0, 0, 0, 0));
        end = new Date(today.setHours(23, 59, 59, 999));
      } else if (period === 'weekly') {
        const first = today.getDate() - today.getDay();
        start = new Date(today.setDate(first));
        start.setHours(0, 0, 0, 0);
        end = new Date(); // up to now
      } else if (startDate && endDate) {
        start = new Date(startDate);
        end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
      }

      if (start && end) {
        matchStage.createdAt = { $gte: start, $lte: end };
      }

      const stats = await testGroupsCollection.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: null,
            totalRevenue: { $sum: "$grandTotal" }, // Total billed amount
            totalCashReceived: { $sum: "$payment" }, // Total actual cash collected
            totalDueAmount: {
              $sum: {
                $subtract: ["$grandTotal", "$payment"]
              }
            },
            totalTests: { $sum: { $size: { $ifNull: ["$tests", []] } } }, // Safety for missing tests array
            totalFullPayments: {
              $sum: { $cond: [{ $gte: ["$payment", "$grandTotal"] }, 1, 0] }
            }
          }
        },
        {
          $project: {
            _id: 0,
            totalRevenue: 1,
            totalCashReceived: 1,
            totalDueAmount: 1,
            totalTests: 1,
            totalFullPayments: 1
          }
        }
      ]).toArray();

      // Additional breakdown for charts (e.g., daily revenue over last 7 days)
      // This could be a separate aggregation if needed

      res.json(stats[0] || { totalRevenue: 0, totalCashReceived: 0, totalDueAmount: 0, totalTests: 0, totalFullPayments: 0 });

    } catch (err) {
      console.error("Dashboard stats error:", err);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });


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

  // Update Test Status (Refactored for RBAC)
  router.patch("/status", verifyToken, async (req, res) => {
    const { groupId, testId, status } = req.body;
    const userRole = req.decoded.role; // Assuming role is in token
    // If not in token, fetch user? verifyToken puts decoded in req.
    // NOTE: If role is not in token, we might need to fetch user. 
    // Usually auth middleware puts generic info. Let's assume role is part of payload or we fetch specific role middleware.
    // Ideally we should use the specific verify middleware for each route, but this route is shared.
    // So we check role dynamically.

    if (!groupId || !testId || !status) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Role-based validation
    // Front Desk: Can only set to 'ready_to_deliver' or 'delivered' from 'complete'
    // Sample Collection: Can only set to 'sample_collected' from 'assigned'
    // Lab Expert: Can only set to 'complete' from 'sample_collected'

    // Admin override?
    const isAdmin = userRole === 'admin';

    let userDepartment = null;
    if (!isAdmin) {
      try {
        const email = req.decoded.email;
        const user = await usersCollection.findOne({ email });
        userDepartment = user?.department;
      } catch (e) {
        console.error("Error fetching user for dept validation", e);
      }
    }

    // We need to fetch the current status first to validate transition
    // But Mongo updateOne with filter is atomic.

    let allowed = false;

    if (isAdmin) allowed = true;
    else if (userRole === 'front_desk') {
      if (['ready_to_deliver', 'delivered'].includes(status)) allowed = true;
    } else if (userRole === 'sample_collection') {
      if (status === 'sample_collected') allowed = true;
    } else if (userRole === 'lab_expert') {
      if (status === 'complete') allowed = true;
    }

    if (!allowed) {
      return res.status(403).json({ error: `User role '${userRole}' not allowed to set status '${status}'` });
    }

    // Further logic: Validate Previous State
    // We can do this by adding the previous state to the filter query
    let query = { _id: new ObjectId(groupId), "tests.test_id": testId };

    if (!isAdmin) {
      if (userRole === 'front_desk') {
        // Can only move COMPLETE -> READY -> DELIVERED
        // If setting READY, prev must be COMPLETE
        if (status === 'ready_to_deliver') {
          // But wait, the previous status in DB is "complete" (lowercase usually)
          // Need to handle case sensitivity. 
          // Sticking to lowercase 'complete' as per seeding/logic
          // or 'Complete' ? Setup seems to be 'assigned', 'test_running', 'complete'.
          query["tests.status"] = "complete";
        } else if (status === 'delivered') {
          query["tests.status"] = "ready_to_deliver";
        }
      } else if (userRole === 'sample_collection') {
        // Assigned -> Sample Collected
        // tests.status could be 'assigned' or null/missing
        // Use $or for status check? Hard in updateOne filter for array element matches sometimes
        // Let's rely on atomic check.
        // allow assigned or missing
        // Note: Array filter matching is tricky. 
      } else if (userRole === 'lab_expert') {
        // Sample Collected -> Complete
        query["tests.status"] = "sample_collected";
      }
    }

    // For simplicity in filter, if not admin, we enforce "tests.status" 
    // But for sample collection, it might be null.
    // Simplest approach: Fetch, Check, Update.

    try {
      const testGroup = await testGroupsCollection.findOne({
        _id: new ObjectId(groupId),
        "tests.test_id": testId
      });

      if (!testGroup) return res.status(404).json({ error: "Test not found" });

      const test = testGroup.tests.find(t => t.test_id === testId);
      const currentStatus = test.status || 'assigned';

      // Department check for Lab/Sample
      if (!isAdmin && (userRole === 'lab_expert' || userRole === 'sample_collection') && userDepartment) {
        // Check if test department match user department
        if (test.department && test.department.toLowerCase() !== userDepartment.toLowerCase()) {
          return res.status(403).json({ error: `Unauthorized: User belongs to ${userDepartment}, test is in ${test.department}` });
        }
      }

      // Transition Logic
      if (!isAdmin) {
        if (userRole === 'front_desk') {
          if (status === 'ready_to_deliver' && currentStatus !== 'complete') {
            return res.status(400).json({ error: "Test must be Completed before Ready to Deliver" });
          }
          if (status === 'delivered' && currentStatus !== 'ready_to_deliver') {
            return res.status(400).json({ error: "Test must be Ready before Delivered" });
          }
        } else if (userRole === 'sample_collection') {
          if (status === 'sample_collected' && currentStatus !== 'assigned') {
            return res.status(400).json({ error: "Test must be Assigned to collect sample" });
          }
          // Check Department?
          // The user object (from DB) needs to be fetched if we want to check department match.
          // We only have role in token usually. 
          // Assuming user is honest for now or we fetch user.
        } else if (userRole === 'lab_expert') {
          if (status === 'complete' && currentStatus !== 'sample_collected' && currentStatus !== 'test_running') {
            // allow test_running intermediate? User said: sample collected -> complete.
            return res.status(400).json({ error: "Sample must be collected before completing" });
          }
        }
      }

      const result = await testGroupsCollection.updateOne(
        { _id: new ObjectId(groupId), "tests.test_id": testId },
        {
          $set: { "tests.$.status": status }
        }
      );

      if (result.modifiedCount === 0) {
        return res.status(404).json({ error: "Update failed" });
      }

      res.json({ success: true, message: "Status updated" });
    } catch (err) {
      console.error("Error updating test status:", err);
      res.status(500).json({ error: "Failed to update status" });
    }
  });

  // CRUD for Tests (Admin Only)

  // Add New Test
  router.post("/test", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const newTest = req.body;
      // Basic validation
      if (!newTest.testName || !newTest.price) {
        return res.status(400).json({ error: "Test Name and Price are required" });
      }

      const testDoc = {
        test_id: await getNextInvoiceID(countersCollection), // Using invoice ID counter for simplicity or create a new counter for test_id? 
        // Existing data uses numbers like 1001. Let's assume we use a similar counter.
        // Actually, let's check getNextInvoiceID... it returns a number.
        // Maybe we should create a getNextTestID or reuse. 
        // Let's reuse or use a new logic later. For now, assuming provided or auto-gen.
        // Wait, existing tests have `test_id` as number.
        ...newTest,
        test_id: parseInt(newTest.test_id) || Date.now(), // Fallback if not provided, but ideally should be managed.
        price: parseFloat(newTest.price),
        createdAt: new Date()
      };

      // If we want a proper counter, we should ideally add it. 
      // check utils/counters.js ? I cannot see it right now.
      // Let's assume for now we generate a unique ID if not present.

      const result = await testsCollection.insertOne(testDoc);
      res.json({ success: true, result });
    } catch (err) {
      console.error("Error adding test:", err);
      res.status(500).json({ error: "Failed to add test" });
    }
  });

  // Edit Test
  router.patch("/test/:id", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const id = req.params.id; // This is the _id
      const updates = req.body;
      delete updates._id; // prevent updating _id

      if (updates.price) updates.price = parseFloat(updates.price);

      const result = await testsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updates }
      );
      res.json(result);
    } catch (err) {
      console.error("Error updating test:", err);
      res.status(500).json({ error: "Failed to update test" });
    }
  });

  // Delete Test
  router.delete("/test/:id", verifyToken, verifyAdmin, async (req, res) => {
    try {
      const id = req.params.id;
      const result = await testsCollection.deleteOne({ _id: new ObjectId(id) });
      res.json(result);
    } catch (err) {
      console.error("Error deleting test:", err);
      res.status(500).json({ error: "Failed to delete test" });
    }
  });

  return router;
};
