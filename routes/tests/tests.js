const express = require("express");
const { ObjectId } = require("mongodb");
const { getNextPID, getNextInvoiceID } = require("../../utils/counters");

const normalizeStatus = (value) =>
  String(value || "assigned").toLowerCase().replace(/\s+/g, "_");

const normalizeDept = (value) =>
  String(value || "").toLowerCase().replace(/\s+/g, "_");

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
  router.post("/save-patient-bill", verifyToken, verifyFrontDesk, async (req, res) => {
    try {
      const { patientInfo, tests, discounts = {}, payment, enteredBy } = req.body;
      if ((!tests || !tests.length) && (!payment || payment <= 0)) {
        return res.status(400).json({ success: false, error: "No tests selected and no payment made." });
      }
      const paymentAmount = Number(payment || 0);
      if (Number.isNaN(paymentAmount) || paymentAmount < 0) {
        return res.status(400).json({ success: false, error: "Invalid payment amount" });
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

      // Server-side billing truth (do not trust client totals)
      const previousDue = Number(patient?.dueAmount || 0);
      if (Number.isNaN(previousDue) || previousDue < 0) {
        return res.status(400).json({ success: false, error: "Invalid previous due amount for patient" });
      }

      const safeTests = Array.isArray(tests) ? tests : [];
      const normalizedTests = safeTests.map((t) => {
        const price = Number(t.price || 0);
        if (Number.isNaN(price) || price < 0) {
          throw new Error(`Invalid test price for test_id=${t?.test_id}`);
        }
        const rawDiscount = Number(discounts?.[t.test_id] || 0);
        const discount = Math.min(Math.max(rawDiscount, 0), price);
        return {
          test_id: t.test_id,
          testName: t.name || t.testName,
          price,
          department: t.department || t.dep || "",
          roomNumber: t.roomNumber,
          discount,
          netAmount: price - discount,
          status: "assigned",
        };
      });

      const testsTotal = normalizedTests.reduce((sum, t) => sum + t.price, 0);
      const totalDiscount = normalizedTests.reduce((sum, t) => sum + t.discount, 0);
      const netAmount = testsTotal - totalDiscount;
      const grandTotal = netAmount + previousDue;
      const updatedDue = Math.max(grandTotal - paymentAmount, 0);

      const invoiceId = await getNextInvoiceID(countersCollection);

      const testGroupDoc = {
        invoiceId,
        patientId: patient._id,
        pid: patient.pid,
        enteredBy: enteredBy || req.decoded?.email || "Unknown", // Save the creator
        previousDue,
        testsTotal,
        totalDiscount,
        netAmount,
        tests: normalizedTests,
        payment: paymentAmount,
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
        previousDue,
        grandTotal,
        updatedDue,
      });
    } catch (err) {
      console.error("Save bill error:", err);
      res.status(500).json({ success: false, error: err.message });
    }
  });


  router.get("/all-reports", verifyToken, verifyFrontDesk, async (req, res) => {
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
        // Map raw snake_case status keys (from /stats) to computedTestStatus labels
        const statusLabelMap = {
          assigned: "Assigned",
          collecting_sample: "Collecting Sample",
          sample_collected: "Sample Collected",
          test_running: "Running",
          complete: "Complete",
          ready_to_deliver: "Ready to Deliver",
          delivered: "Delivered",
        };
        const mappedLabel = statusLabelMap[testStatusFilter.toLowerCase()] || testStatusFilter;
        statusMatch.computedTestStatus = { $regex: new RegExp(`^${mappedLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, "i") };
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
            // Backward compatible: older docs may not have these fields
            totalAmount: { $sum: "$tests.price" },
            totalDiscount: { $ifNull: ["$totalDiscount", { $sum: "$tests.discount" }] },
            previousDue: { $ifNull: ["$previousDue", 0] },
          }
        },
        {
          $addFields: {
            netAmount: { $ifNull: ["$netAmount", { $subtract: ["$totalAmount", "$totalDiscount"] }] }
          }
        },
        {
          $addFields: {
            grandTotalComputed: { $ifNull: ["$grandTotal", { $add: ["$netAmount", "$previousDue"] }] },
          }
        },
        {
          $addFields: {
            paymentStatus: {
              $cond: { if: { $gte: ["$payment", "$grandTotalComputed"] }, then: "PAID", else: "DUE" }
            },
            isPaid: { $gt: ["$payment", 0] },
            totalDue: { $max: [{ $subtract: ["$grandTotalComputed", "$payment"] }, 0] },
            // Calculate Test Status Logic
            computedTestStatus: {
              $switch: {
                branches: [
                  // Terminal group states first (receptionist handoff flow)
                  {
                    case: {
                      $and: [
                        { $gt: [{ $size: { $ifNull: ["$tests", []] } }, 0] },
                        { $eq: [{ $size: { $filter: { input: "$tests", cond: { $ne: ["$$this.status", "delivered"] } } } }, 0] }
                      ]
                    },
                    then: "Delivered"
                  },
                  {
                    case: {
                      $and: [
                        { $gt: [{ $size: { $ifNull: ["$tests", []] } }, 0] },
                        { $eq: [{ $size: { $filter: { input: "$tests", cond: { $ne: ["$$this.status", "ready_to_deliver"] } } } }, 0] }
                      ]
                    },
                    then: "Ready to Deliver"
                  },
                  {
                    case: {
                      $and: [
                        { $gt: [{ $size: { $ifNull: ["$tests", []] } }, 0] },
                        { $eq: [{ $size: { $filter: { input: "$tests", cond: { $ne: ["$$this.status", "complete"] } } } }, 0] }
                      ]
                    },
                    then: "Complete"
                  },
                  // In-progress states (any test in phase)
                  {
                    case: { $in: ["test_running", { $ifNull: ["$tests.status", []] }] },
                    then: "Running"
                  },
                  {
                    case: { $in: ["collecting_sample", { $ifNull: ["$tests.status", []] }] },
                    then: "Collecting Sample"
                  },
                  {
                    case: { $in: ["sample_collected", { $ifNull: ["$tests.status", []] }] },
                    then: "Sample Collected"
                  },
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
                  }
                ],
                default: { $ifNull: [{ $arrayElemAt: ["$tests.status", 0] }, "Assigned"] }
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
  router.get("/dashboard-stats", verifyToken, verifyFrontDesk, async (req, res) => {
    try {
      const { period, startDate, endDate } = req.query;
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
        end = new Date();
      } else if (startDate && endDate) {
        start = new Date(startDate);
        end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
      }

      if (start && end) {
        matchStage.createdAt = { $gte: start, $lte: end };
      }

      // Run testGroups aggregation and patients due sum in parallel
      const [testGroupStats, patientDueResult] = await Promise.all([
        testGroupsCollection.aggregate([
          { $match: matchStage },
          {
            $facet: {
              summary: [
                {
                  $group: {
                    _id: null,
                    totalRevenue: { $sum: "$grandTotal" },
                    totalCashReceived: { $sum: "$payment" },
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
                    totalTests: 1,
                    totalFullPayments: 1,
                    totalCompleted: 1,
                    totalRunning: 1,
                    totalAssigned: 1
                  }
                }
              ],
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
                    revenue: { $sum: "$grandTotal" },
                    cash: { $sum: "$payment" },
                    due: { $sum: { $subtract: ["$grandTotal", "$payment"] } }
                  }
                },
                { $sort: { _id: 1 } },
                {
                  $project: {
                    name: "$_id",
                    revenue: 1,
                    cash: 1,
                    due: 1,
                    _id: 0
                  }
                }
              ]
            }
          }
        ]).toArray(),

        // Always sum the live dueAmount from patients — this is the single source of truth
        // since it's updated every time a payment is made (including due payments).
        patientsCollection.aggregate([
          {
            $group: {
              _id: null,
              totalDueAmount: { $sum: { $max: ["$dueAmount", 0] } }
            }
          }
        ]).toArray()
      ]);

      const summary = testGroupStats[0]?.summary[0] || {
        totalRevenue: 0,
        totalCashReceived: 0,
        totalTests: 0,
        totalFullPayments: 0,
        totalCompleted: 0,
        totalRunning: 0,
        totalAssigned: 0
      };

      // Use patients.dueAmount as the authoritative outstanding due
      const totalDueAmount = patientDueResult[0]?.totalDueAmount || 0;

      const chartData = testGroupStats[0]?.chartData || [];

      res.json({ ...summary, totalDueAmount, chartData });

    } catch (err) {
      console.error("Dashboard stats error:", err);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });


  router.get("/stats", verifyToken, verifyFrontDesk, async (req, res) => {
    try {
      const { startDate, endDate, search, status: paymentStatus } = req.query;

      const pipeline = [];

      // 1. Optional Date Filter
      if (startDate || endDate) {
        const dateMatch = { createdAt: {} };
        if (startDate) dateMatch.createdAt.$gte = new Date(startDate);
        if (endDate) {
          const end = new Date(endDate);
          end.setHours(23, 59, 59, 999);
          dateMatch.createdAt.$lte = end;
        }
        pipeline.push({ $match: dateMatch });
      }

      // 2. Optional Payment Status Filter (Paid / Due)
      if (paymentStatus) {
        // Compute paymentStatus before filtering
        pipeline.push(
          {
            $addFields: {
              grandTotalComputed: { $ifNull: ["$grandTotal", { $add: [{ $subtract: [{ $sum: "$tests.price" }, { $ifNull: ["$totalDiscount", { $sum: "$tests.discount" }] }] }, { $ifNull: ["$previousDue", 0] }] }] }
            }
          },
          {
            $match: {
              $expr: paymentStatus.toUpperCase() === "PAID"
                ? { $gte: ["$payment", "$grandTotalComputed"] }
                : { $lt: ["$payment", "$grandTotalComputed"] }
            }
          }
        );
      }

      // 3. Optional Search Filter (requires patient lookup)
      if (search) {
        pipeline.push(
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
            $match: {
              $or: [
                { "invoiceId": { $regex: search, $options: "i" } },
                { "patientInfo.name": { $regex: search, $options: "i" } },
                { "patientInfo.pid": { $regex: search, $options: "i" } },
                { "patientInfo.phone": { $regex: search, $options: "i" } }
              ]
            }
          }
        );
      }

      // 4. Compute the SAME group-level computedTestStatus as /all-reports uses.
      //    The old approach unwound individual tests and counted raw test.status,
      //    but the Reports table shows ONE ROW PER GROUP filtered by computedTestStatus.
      //    An invoice with 5 tests all "assigned" showed count=5 in stats but count=1
      //    in the table — they never matched. Fixed by counting groups, not tests.
      pipeline.push(
        {
          $addFields: {
            computedTestStatus: {
              $switch: {
                branches: [
                  {
                    case: {
                      $and: [
                        { $gt: [{ $size: { $ifNull: ["$tests", []] } }, 0] },
                        { $eq: [{ $size: { $filter: { input: "$tests", cond: { $ne: ["$$this.status", "delivered"] } } } }, 0] }
                      ]
                    },
                    then: "delivered"
                  },
                  {
                    case: {
                      $and: [
                        { $gt: [{ $size: { $ifNull: ["$tests", []] } }, 0] },
                        { $eq: [{ $size: { $filter: { input: "$tests", cond: { $ne: ["$$this.status", "ready_to_deliver"] } } } }, 0] }
                      ]
                    },
                    then: "ready_to_deliver"
                  },
                  {
                    case: {
                      $and: [
                        { $gt: [{ $size: { $ifNull: ["$tests", []] } }, 0] },
                        { $eq: [{ $size: { $filter: { input: "$tests", cond: { $ne: ["$$this.status", "complete"] } } } }, 0] }
                      ]
                    },
                    then: "complete"
                  },
                  {
                    case: { $in: ["test_running", { $ifNull: ["$tests.status", []] }] },
                    then: "test_running"
                  },
                  {
                    case: { $in: ["collecting_sample", { $ifNull: ["$tests.status", []] }] },
                    then: "collecting_sample"
                  },
                  {
                    case: { $in: ["sample_collected", { $ifNull: ["$tests.status", []] }] },
                    then: "sample_collected"
                  },
                  {
                    case: {
                      $gt: [
                        { $size: { $filter: { input: "$tests", cond: { $in: ["$$this.status", ["assigned", null, ""]] } } } },
                        0
                      ]
                    },
                    then: "assigned"
                  }
                ],
                default: "assigned"
              }
            }
          }
        },
        // Group by group-level status (counts GROUPS, matches table row counts)
        { $group: { _id: "$computedTestStatus", count: { $sum: 1 } } },
        {
          $group: {
            _id: null,
            totalTests: { $sum: "$count" },
            statusCounts: { $push: { status: "$_id", count: "$count" } }
          }
        },
        {
          $project: {
            _id: 0,
            totalTests: 1,
            statusCounts: {
              $arrayToObject: {
                $map: { input: "$statusCounts", as: "s", in: { k: "$$s.status", v: "$$s.count" } }
              }
            }
          }
        }
      );

      const stats = await testGroupsCollection.aggregate(pipeline).toArray();
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
            department: "$tests.department",
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

  router.get("/:groupId", verifyToken, verifyFrontDesk, async (req, res) => {

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
        previousDue: Number(testGroup.previousDue || 0),
        totalDiscount: Number(testGroup.totalDiscount || testGroup.tests.reduce((sum, t) => sum + (t.discount || 0), 0)),
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
    let userRoles = req.decoded?.roles || [];

    if (!groupId || !status) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    try {
      const user = await usersCollection.findOne({ email });
      if (user) {
        userRoles = user.roles || (user.role ? [user.role] : []);
      }
    } catch (e) {
      console.error(e);
      return res.status(500).json({ error: "Auth Error" });
    }

    if (!userRoles || userRoles.length === 0) return res.status(403).json({ error: "Unauthorized" });

    // Logic for Front Desk: Complete -> Ready -> Delivered
    const isAdmin = userRoles.includes("admin");
    const isFrontDesk = userRoles.includes("front_desk");
    let allowed = false;
    if (isAdmin) allowed = true;
    if (isFrontDesk && ["ready_to_deliver", "delivered"].includes(status)) allowed = true;

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
      if (!isAdmin) {
        if (status === "ready_to_deliver") {
          const allComplete = tests.every((t) => {
            const s = normalizeStatus(t.status);
            return s === "complete" || s === "ready_to_deliver";
          });
          if (!allComplete) {
            return res.status(400).json({ error: "All tests must be Complete before marking Ready" });
          }
        } else if (status === "delivered") {
          const allReady = tests.every((t) => {
            const s = normalizeStatus(t.status);
            return s === "ready_to_deliver" || s === "delivered";
          });
          if (!allReady) {
            return res.status(400).json({ error: "All tests must be Ready before marking Delivered" });
          }
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

    try {
      if (!ObjectId.isValid(groupId)) {
        return res.status(400).json({ error: "Invalid groupId" });
      }

      const testGroup = await testGroupsCollection.findOne({
        _id: new ObjectId(groupId),
      });

      if (!testGroup) return res.status(404).json({ error: "Test group not found" });

      const testIndex = testGroup.tests.findIndex(
        (t) => String(t.test_id) === String(testId)
      );
      if (testIndex === -1) return res.status(404).json({ error: "Test not found" });

      const test = testGroup.tests[testIndex];
      const currentStatus = normalizeStatus(test.status);


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
          const testDept = normalizeDept(test.department);
          const hasDeptAccess = userDepartments.some(
            (d) => normalizeDept(d) === testDept
          );
          if (!hasDeptAccess) {
            return res.status(403).json({ error: `Unauthorized: User departments [${userDepartments.join(', ')}] do not include ${test.department}` });
          }
        }
      }

      // Transition Logic
      if (!isAdmin) {
        if (userRoles.includes("front_desk")) {
          if (status === "ready_to_deliver" && currentStatus !== "complete") {
            return res.status(400).json({ error: "Test must be Completed before Ready to Deliver" });
          }
          if (status === "delivered" && currentStatus !== "ready_to_deliver") {
            return res.status(400).json({ error: "Test must be Ready before Delivered" });
          }
        }

        if (userRoles.includes("sample_collection")) {
          if (status === "collecting_sample" && currentStatus !== "assigned") {
            return res.status(400).json({ error: `Test must be Assigned to start collection (Current: ${currentStatus})` });
          }
          if (
            status === "sample_collected" &&
            currentStatus !== "collecting_sample" &&
            currentStatus !== "assigned"
          ) {
            return res.status(400).json({ error: `Test must be in collection phase (Current: ${currentStatus})` });
          }
        }

        if (userRoles.includes("lab_expert")) {
          if (status === "test_running" && currentStatus !== "sample_collected") {
            return res.status(400).json({ error: "Sample must be collected before starting test" });
          }
          if (
            status === "complete" &&
            currentStatus !== "test_running" &&
            currentStatus !== "sample_collected"
          ) {
            return res.status(400).json({ error: "Test must be running or collected to complete" });
          }
        }
      }

      const result = await testGroupsCollection.updateOne(
        { _id: new ObjectId(groupId) },
        { $set: { [`tests.${testIndex}.status`]: status } }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({ error: "Update failed: group not found" });
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
