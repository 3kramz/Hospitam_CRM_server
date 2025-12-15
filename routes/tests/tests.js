const express = require("express");
const { ObjectId } = require("mongodb");
const { getNextPID, getNextInvoiceID } = require("../../utils/counters");

module.exports = (db, verifyToken, verifyLabExpert, verifyFrontDesk, verifySampleCollection, verifyAdmin, verifyLabAccess) => {
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
  // /save-patient-bill
  router.post("/save-patient-bill", verifyToken, async (req, res) => {
    try {
      const { patientInfo, tests, discounts, payment, grandTotal, enteredBy } = req.body;
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
        enteredBy: enteredBy || req.decoded?.email || "Unknown", // Save the creator
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
      const testStatusFilter = req.query.testStatus || "";
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

      // --- Optimization: Build Matches First ---

      // 1. Date Filter (Indexable, fast, field exists on root)
      const dateMatch = {};
      const startDate = req.query.startDate;
      const endDate = req.query.endDate;

      if (startDate || endDate) {
        dateMatch.createdAt = {};
        if (startDate) dateMatch.createdAt.$gte = new Date(startDate);
        if (endDate) {
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          dateMatch.createdAt.$lte = end;
        }
      }

      // 2. Search Filter (Split into pre-lookup and post-lookup if needed, but mostly post-lookup for patient info)
      // Since InvoiceId is on root, we COULD match it early, but Patient Name requires Lookup.
      // To keep it simple but faster than "After Calculations", we'll do:
      // Match Date -> Lookup -> Match Search -> Calculate -> Match Status
      const searchMatch = {};
      if (search) {
        const regex = { $regex: search, $options: "i" };
        searchMatch.$or = [
          { "invoiceId": regex },
          { "patientInfo.name": regex },
          { "patientInfo.pid": regex },
          { "patientInfo.phone": regex },
        ];
      }

      // 3. Status Filter (Requires Calculations?)
      // PaymentStatus is calculated. TestStatus is calculated.
      // So these MUST go after calculations.
      const statusMatch = {};
      if (statusFilter) {
        statusMatch.paymentStatus = statusFilter.toUpperCase();
      }
      if (testStatusFilter) {
        statusMatch["tests.status"] = { $regex: new RegExp(`^${testStatusFilter}$`, "i") };
      }
      if (paymentFilter) {
        if (paymentFilter === 'paid') statusMatch.payment = { $gt: 0 };
        else if (paymentFilter === 'unpaid') statusMatch.payment = { $eq: 0 };
      }


      const pipeline = [];

      // Stage 1: Date Match (Earliest/Fastest reduction)
      if (Object.keys(dateMatch).length > 0) {
        pipeline.push({ $match: dateMatch });
      }

      // Stage 2: Lookup Patient
      pipeline.push(
        {
          $lookup: {
            from: "patients",
            localField: "patientId",
            foreignField: "_id",
            as: "patientInfo"
          }
        },
        { $unwind: { path: "$patientInfo", preserveNullAndEmptyArrays: true } }
      );

      // Stage 3: Search Match (Before heavy calcs)
      if (Object.keys(searchMatch).length > 0) {
        pipeline.push({ $match: searchMatch });
      }

      // Stage 4: Heavy Calculations
      pipeline.push(
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
                  // If any test is running
                  {
                    case: { $in: ["test_running", { $ifNull: ["$tests.status", []] }] },
                    then: "Running"
                  },
                  // If any is collecting sample
                  {
                    case: { $in: ["collecting_sample", { $ifNull: ["$tests.status", []] }] },
                    then: "Collecting Sample"
                  },
                  // If any is sample collected (and not running/collecting) -> implies others might be assigned or collected
                  {
                    case: { $in: ["sample_collected", { $ifNull: ["$tests.status", []] }] },
                    then: "Sample Collected"
                  },
                  // If any is assigned (or null/empty status), report is Assigned/Pending
                  {
                    case: {
                      $gt: [
                        {
                          $size: {
                            $filter: {
                              input: "$tests",
                              cond: { $in: ["$$this.status", ["assigned", null, ""]] }
                            }
                          }
                        },
                        0
                      ]
                    },
                    then: "Assigned"
                  },
                  // Check if ALL are delivered
                  {
                    case: {
                      $and: [
                        { $gt: [{ $size: { $ifNull: ["$tests", []] } }, 0] },
                        { $eq: [{ $size: { $filter: { input: "$tests", cond: { $ne: ["$$this.status", "delivered"] } } } }, 0] }
                      ]
                    },
                    then: "Delivered"
                  },
                  // Check if ALL are ready_to_deliver
                  {
                    case: {
                      $and: [
                        { $gt: [{ $size: { $ifNull: ["$tests", []] } }, 0] },
                        { $eq: [{ $size: { $filter: { input: "$tests", cond: { $ne: ["$$this.status", "ready_to_deliver"] } } } }, 0] }
                      ]
                    },
                    then: "Ready to Deliver"
                  },
                  // Check if ALL are complete (or ready/delivered - strict complete check)
                  // Actually if it's mixed 'complete' and 'ready', it's technically 'Complete' (waiting for all to be ready).
                  // But for simplicity, let's say ALL must be complete to show 'Complete'.
                  {
                    case: {
                      $and: [
                        { $gt: [{ $size: { $ifNull: ["$tests", []] } }, 0] },
                        { $eq: [{ $size: { $filter: { input: "$tests", cond: { $ne: ["$$this.status", "complete"] } } } }, 0] }
                      ]
                    },
                    then: "Complete"
                  }
                ],
                default: { $ifNull: [{ $arrayElemAt: ["$tests.status", 0] }, "Assigned"] } // Fallback to first test status if unknown
              }
            }
          }
        }
      );

      // Stage 5: Status Match (After calcs)
      if (Object.keys(statusMatch).length > 0) {
        pipeline.push({ $match: statusMatch });
      }

      // Stage 6: Sort & Facet
      pipeline.push(
        { $sort: { [sortKey]: sortOrder } },
        {
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
        }
      );

      const results = await testGroupsCollection.aggregate(pipeline).toArray();

      const data = results[0].data || [];
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
  router.get("/dashboard-stats", verifyToken, async (req, res) => {
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
          $facet: {
            // 1. Overall Summary Stats
            summary: [
              {
                $group: {
                  _id: null,
                  totalRevenue: { $sum: "$grandTotal" },
                  totalCashReceived: { $sum: "$payment" },
                  totalDueAmount: { $sum: { $subtract: ["$grandTotal", "$payment"] } },
                  totalTests: { $sum: { $size: { $ifNull: ["$tests", []] } } },
                  totalFullPayments: { $sum: { $cond: [{ $gte: ["$payment", "$grandTotal"] }, 1, 0] } },
                  totalCompleted: {
                    $sum: {
                      $size: {
                        $filter: {
                          input: { $ifNull: ["$tests", []] },
                          as: "t",
                          cond: { $eq: [{ $toLower: { $ifNull: ["$$t.status", "assigned"] } }, "complete"] }
                        }
                      }
                    }
                  },
                  totalRunning: {
                    $sum: {
                      $size: {
                        $filter: {
                          input: { $ifNull: ["$tests", []] },
                          as: "t",
                          cond: {
                            $or: [
                              { $eq: [{ $toLower: { $ifNull: ["$$t.status", "assigned"] } }, "running"] },
                              { $eq: [{ $toLower: { $ifNull: ["$$t.status", "assigned"] } }, "test_running"] }
                            ]
                          }
                        }
                      }
                    }
                  },
                  totalAssigned: {
                    $sum: {
                      $size: {
                        $filter: {
                          input: { $ifNull: ["$tests", []] },
                          as: "t",
                          cond: {
                            $or: [
                              { $eq: [{ $toLower: { $ifNull: ["$$t.status", "assigned"] } }, "assigned"] },
                              { $eq: ["$$t.status", null] },
                              { $eq: ["$$t.status", ""] }
                            ]
                          }
                        }
                      }
                    }
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
                  totalFullPayments: 1,
                  totalCompleted: 1,
                  totalRunning: 1,
                  totalAssigned: 1
                }
              }
            ],
            // 2. Chart Data (Daily Breakdown)
            chartData: [
              {
                $project: {
                  dateStr: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
                  grandTotal: 1,
                  payment: 1
                }
              },
              {
                $group: {
                  _id: "$dateStr",
                  revenue: { $sum: "$grandTotal" }, // Revenue = Billed Amount
                  cash: { $sum: "$payment" }, // Cash = Received
                  due: { $sum: { $subtract: ["$grandTotal", "$payment"] } } // Due
                }
              },
              { $sort: { _id: 1 } }, // Sort by date ascending
              {
                $project: {
                  name: "$_id", // for chart x-axis
                  revenue: 1,
                  cash: 1,
                  due: 1,
                  _id: 0
                }
              }
            ]
          }
        }
      ]).toArray();

      const summary = stats[0].summary[0] || {
        totalRevenue: 0,
        totalCashReceived: 0,
        totalDueAmount: 0,
        totalTests: 0,
        totalFullPayments: 0,
        totalCompleted: 0,
        totalRunning: 0,
        totalAssigned: 0
      };

      const chartData = stats[0].chartData || [];



      res.json({ ...summary, chartData });

    } catch (err) {
      console.error("Dashboard stats error:", err);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });


  router.get("/stats", verifyToken, async (req, res) => {
    try {

      const stats = await testGroupsCollection.aggregate([
        { $unwind: "$tests" },
        {
          $group: {
            _id: { $toLower: { $ifNull: ["$tests.status", "assigned"] } }, // Group by status, default to 'assigned'
            count: { $sum: 1 }
          }
        },
        {
          $group: {
            _id: null,
            totalTests: { $sum: "$count" },
            statusCounts: {
              $push: {
                status: "$_id",
                count: "$count"
              }
            }
          }
        },
        {
          $project: {
            _id: 0,
            totalTests: 1,
            statusCounts: {
              $arrayToObject: {
                $map: {
                  input: "$statusCounts",
                  as: "s",
                  in: { k: "$$s.status", v: "$$s.count" }
                }
              }
            }
          }
        }
      ]).toArray();

      const result = stats[0] || { totalTests: 0, statusCounts: {} };


      res.json(result);
    } catch (err) {
      console.error("Error fetching stats:", err);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });


  // Get all tests for Lab Expert (Lab Queue)
  router.get("/lab-queue", verifyToken, verifyLabAccess, async (req, res) => {
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

  // Bulk Update Group/Report Status
  router.patch("/group-status", verifyToken, async (req, res) => {
    const { groupId, status } = req.body;
    const email = req.decoded?.email;
    let userRole = req.decoded.role;

    if (!groupId || !status) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const user = await usersCollection.findOne({ email });
      if (user) {
        userRole = user.role;
      }
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Auth Error" });
    }

    if (!userRole) return res.status(403).json({ error: "Unauthorized" });

    // Logic for Front Desk: Complete -> Ready -> Delivered
    let allowed = false;
    if (userRole === 'admin') allowed = true;
    if (userRole === 'front_desk' && ['ready_to_deliver', 'delivered'].includes(status)) allowed = true;

    if (!allowed) {
      return res.status(403).json({ error: "Not authorized for this status change" });
    }

    try {
      const group = await testGroupsCollection.findOne({ _id: new ObjectId(groupId) });
      if (!group) return res.status(404).json({ error: "Report not found" });

      // Enforcement of flow
      // If changing to 'ready_to_deliver', all tests must be 'complete' (or already ready/delivered?)
      // If changing to 'delivered', all tests must be 'ready_to_deliver' (or delivered)
      // Simpler verification: Check if we can transition.

      // We iterate and update all tests that match the criteria?
      // Or just update all tests unconditionally?
      // Better to update ALL tests to the new status to keep them in sync for the report.

      // Pre-check
      const tests = group.tests || [];
      if (!userRole === 'admin') {
        if (status === 'ready_to_deliver') {
          // Ensure all tests are 'complete'
          const allComplete = tests.every(t => t.status === 'complete' || t.status === 'ready_to_deliver');
          if (!allComplete) return res.status(400).json({ error: "All tests must be Complete before marking Ready" });
        } else if (status === 'delivered') {
          // Ensure all tests are 'ready_to_deliver'
          const allReady = tests.every(t => t.status === 'ready_to_deliver' || t.status === 'delivered');
          // if we allow Complete -> Delivered directly? User said: "Complete to ready to deliver and finally delivered". Strict flow.
          if (!allReady) return res.status(400).json({ error: "All tests must be Ready before marking Delivered" });
        }
      }

      // Update all tests
      // Using $set with array identifier is not possible for all elements easily without knowing indices or using $[] (all positional operator)
      // MongoDB $[] operator updates all elements in array.

      const updateResult = await testGroupsCollection.updateOne(
        { _id: new ObjectId(groupId) },
        { $set: { "tests.$[].status": status } }
      );

      res.json({ success: true, message: `Report marked as ${status}` });

    } catch (err) {
      console.error("Group status update error:", err);
      res.status(500).json({ error: "Failed to update" });
    }
  });

  // Update Test Status (Refactored for RBAC)
  router.patch("/status", verifyToken, async (req, res) => {
    const { groupId, testId, status } = req.body;
    let userRole = req.decoded.role;
    const email = req.decoded?.email;



    if (!groupId || !testId || !status) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    let userDepartment = null;
    let userRoles = [];
    let user = null;

    // Always fetch user to get reliable Role and Department if possible
    // (unless token explicitly has it, but based on analysis token ONLY has email)
    // So we primarily rely on DB fetch.
    try {
      user = await usersCollection.findOne({ email });
      if (user) {
        // Fallback for backward compatibility
        userRoles = user.roles || (user.role ? [user.role] : []);
        userDepartment = user.department;
      }
    } catch (e) {
      console.error("Error fetching user for validation", e);
      return res.status(500).json({ error: "Server error validating user" });
    }

    // Fallback if user not found (shouldn't happen with valid token)
    if (!userRoles || userRoles.length === 0) {
      return res.status(403).json({ error: "Unauthorized: User role not found" });
    }

    const isAdmin = userRoles.includes('admin');

    // We need to fetch the current status first to validate transition
    // But Mongo updateOne with filter is atomic.

    let allowed = false;

    if (isAdmin) {
      allowed = true;
    } else {
      if (userRoles.includes('front_desk')) {
        if (['ready_to_deliver', 'delivered'].includes(status)) allowed = true;
      }
      if (userRoles.includes('sample_collection')) {
        // Sample collection can start collection and mark collected
        if (['collecting_sample', 'sample_collected'].includes(status)) allowed = true;
      }
      if (userRoles.includes('lab_expert')) {
        // Lab expert can start test and complete it
        if (['test_running', 'complete'].includes(status)) allowed = true;
      }
    }

    if (!allowed) {
      return res.status(403).json({ error: `User roles '${userRoles.join(", ")}' not allowed to set status '${status}'` });
    }

    // Further logic: Validate Previous State
    // We can do this by adding the previous state to the filter query
    let query = { _id: new ObjectId(groupId), "tests.test_id": testId };

    if (!isAdmin) {
      if (userRoles.includes('front_desk')) {
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
      }
      // Query filters removed for lab_expert to rely on explicit validation logic below.
      // This prevents 404 errors when status logic is valid but query is too strict.
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
      // Department check for Lab/Sample
      // Check if ANY of the user's departments match the test department.
      // And check if user has lab/sample roles.
      if (!isAdmin && (userRoles.includes('lab_expert') || userRoles.includes('sample_collection'))) {
        const userDepartments = user.departments || (userDepartment ? [userDepartment] : []);
        // If user has NO departments assigned, maybe allow all? Or restrict? 
        // Assuming if departments is empty, access is unrestricted OR restricted.
        // Let's assume restricted if departments exist in system.
        // If test has no department, maybe allow.
        if (test.department && userDepartments.length > 0) {
          const hasDeptAccess = userDepartments.some(d => d.toLowerCase() === test.department.toLowerCase());
          if (!hasDeptAccess) {
            return res.status(403).json({ error: `Unauthorized: User departments [${userDepartments.join(', ')}] do not include ${test.department}` });
          }
        }
      }

      // Transition Logic
      if (!isAdmin) {
        if (userRoles.includes('front_desk')) {
          if (status === 'ready_to_deliver' && currentStatus !== 'complete') {
            return res.status(400).json({ error: "Test must be Completed before Ready to Deliver" });
          }
          if (status === 'delivered' && currentStatus !== 'ready_to_deliver') {
            return res.status(400).json({ error: "Test must be Ready before Delivered" });
          }
        }

        if (userRoles.includes('sample_collection')) {
          // Assigned -> Collecting -> Collected
          if (status === 'collecting_sample' && currentStatus !== 'assigned') {
            return res.status(400).json({ error: `Test must be Assigned to start collection (Current: ${currentStatus})` });
          }
          if (status === 'sample_collected' && currentStatus !== 'collecting_sample' && currentStatus !== 'assigned') {
            // Allow directly marking collected if skipping start? Or enforce strict? 
            // Let's allow assigned -> collected for flexibility, but prefer collecting_sample -> collected.
            return res.status(400).json({ error: `Test must be in collection phase (Current: ${currentStatus})` });
          }
        }

        if (userRoles.includes('lab_expert')) {
          // Collected -> Running -> Complete
          if (status === 'test_running' && currentStatus !== 'sample_collected') {
            return res.status(400).json({ error: "Sample must be collected before starting test" });
          }
          if (status === 'complete' && currentStatus !== 'test_running' && currentStatus !== 'sample_collected') {
            // Allow collected -> complete for flexibility
            return res.status(400).json({ error: "Test must be running or collected to complete" });
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
        return res.status(404).json({ error: `Update failed (modifiedCount: 0). Query: ${JSON.stringify(query)}` });
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
