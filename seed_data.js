const { MongoClient } = require("mongodb");
const { getNextPID } = require("./utils/counters");
require("dotenv").config();

// MOCK DATA GENERATORS
const firstNames = ["James", "Mary", "John", "Patricia", "Robert", "Jennifer", "Michael", "Linda", "William", "Elizabeth", "David", "Barbara", "Richard", "Susan", "Joseph", "Jessica", "Thomas", "Sarah", "Charles", "Karen", "Christopher", "Lisa", "Daniel", "Nancy", "Matthew", "Betty", "Anthony", "Margaret", "Donald", "Sandra"];
const lastNames = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin", "Lee", "Perez", "Thompson", "White", "Harris", "Sanchez", "Clark", "Ramirez", "Lewis", "Robinson"];
const genders = ["Male", "Female", "Other"];
const doctors = ["Dr. Smith", "Dr. Jones", "Dr. Strange", "Dr. House", "Dr. Grey", "Dr. Melendez", "Dr. Murphy", "Dr. Shepherd"];

const getRandom = (arr) => arr[Math.floor(Math.random() * arr.length)];
const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const generatePatient = (pid, date) => {
    const fn = getRandom(firstNames);
    const ln = getRandom(lastNames);
    return {
        pid,
        name: `${fn} ${ln}`,
        age: getRandomInt(18, 90),
        gender: getRandom(genders),
        phone: `01${getRandomInt(100000000, 999999999)}`,
        address: `${getRandomInt(1, 999)} Mock Street, Mock City`,
        email: `${fn.toLowerCase()}.${ln.toLowerCase()}@example.com`,
        refDoctor: getRandom(doctors),
        pcName: "",
        dueAmount: 0,
        testGroupIds: [],
        createdAt: date,
        updatedAt: date,
    };
};

const mockTests = [
    { test_id: "T001", name: "Complete Blood Count (CBC)", price: 350 },
    { test_id: "T002", name: "Chest X-Ray", price: 400 },
    { test_id: "T003", name: "Serum Creatinine", price: 250 },
    { test_id: "T004", name: "Liver Function Test (LFT)", price: 900 },
    { test_id: "T005", name: "Urine Routine Examination", price: 150 },
    { test_id: "T006", name: "Blood Sugar Fasting (FBS)", price: 80 },
    { test_id: "T007", name: "Hepatitis B Surface Antigen (HBsAg)", price: 500 },
    { test_id: "T008", name: "USG Whole Abdomen", price: 1200 },
];

async function seed() {
    console.log("Connecting to DB...");
    // Direct connection string just in case .env issues, but preserving original logic where possible
    // process.env.DB_PASS is needed. If script fails, I'll ask user or check .env manually.
    const uri = `mongodb+srv://UserDB:${process.env.DB_PASS}@hospitalcrm.na1fsn2.mongodb.net/?retryWrites=true&w=majority&appName=HospitalCRM`;
    const client = new MongoClient(uri);

    try {
        await client.connect();
        const db = client.db("Hospital_crn");
        const patientsCollection = db.collection("patients");
        const testGroupsCollection = db.collection("testGroups");
        const countersCollection = db.collection("counters");

        console.log("Connected. Seeding 200 records...");

        for (let i = 0; i < 200; i++) {
            // Generate Random Date (Last 90 days)
            const daysAgo = getRandomInt(0, 90);
            const date = new Date();
            date.setDate(date.getDate() - daysAgo);

            // 1. Create Patient
            const pid = await getNextPID(countersCollection);
            const patientData = generatePatient(pid, date);
            const patInsert = await patientsCollection.insertOne(patientData);
            const patientId = patInsert.insertedId;

            // 2. Create Test Group (Bill)
            const numTests = getRandomInt(1, 4);
            const selectedTests = [];
            let grandTotal = 0;

            // Determine Report Status Classification for this group for consistency
            const randStatus = Math.random();
            let targetGroupStatus = "Assigned";
            if (randStatus < 0.33) targetGroupStatus = "Complete";
            else if (randStatus < 0.66) targetGroupStatus = "Running";

            for (let t = 0; t < numTests; t++) {
                const test = getRandom(mockTests);

                let status = "assigned";
                if (targetGroupStatus === "Complete") {
                    status = "complete";
                } else if (targetGroupStatus === "Running") {
                    // For running, at least one needs to be running. Others can be assigned or complete.
                    // Let's make the first one running, others random
                    if (t === 0) status = "test_running";
                    else status = Math.random() > 0.5 ? "assigned" : "complete";
                } else {
                    // Assigned
                    status = "assigned";
                }

                selectedTests.push({
                    test_id: test.test_id,
                    testName: test.name,
                    price: test.price,
                    discount: 0,
                    netAmount: test.price,
                    status: status, // Essential for our new filters
                    uniqueTestInstanceId: new Date().getTime() + "_" + t // Mock unique ID
                });
                grandTotal += test.price;
            }

            // Randomize payment
            const isPaid = Math.random() > 0.4; // 60% paid
            const payment = isPaid ? grandTotal : getRandomInt(0, grandTotal - 1);
            const due = grandTotal - payment;

            const testGroupDoc = {
                patientId: patientId,
                pid: pid,
                tests: selectedTests,
                payment: payment,
                grandTotal: grandTotal,
                createdAt: date,
                updatedAt: date,
                patientName: patientData.name // Storing name here too as some lookups might use it
            };

            const groupInsert = await testGroupsCollection.insertOne(testGroupDoc);
            const groupId = groupInsert.insertedId;

            // 3. Update Patient with Due and GroupId
            await patientsCollection.updateOne(
                { _id: patientId },
                {
                    $push: { testGroupIds: groupId },
                    $set: { dueAmount: due, updatedAt: date }
                }
            );

            if (i % 20 === 0) process.stdout.write(".");
        }

        console.log("\nSeeding complete!");

    } catch (err) {
        console.error("Seeding failed:", err);
    } finally {
        await client.close();
    }
}

seed();
