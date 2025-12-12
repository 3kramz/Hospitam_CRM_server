const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");
dotenv.config();

const uri = `mongodb+srv://UserDB:${process.env.DB_PASS}@hospitalcrm.na1fsn2.mongodb.net/?retryWrites=true&w=majority&appName=HospitalCRM`;
const client = new MongoClient(uri);

const testMaster = [
    { name: "Hemoglobin (Hb)", price: 100, test_id: "HB" },
    { name: "Complete Blood Count (CBC)", price: 350, test_id: "CBC" },
    { name: "Liver Function Test (LFT)", price: 900, test_id: "LFT" },
    { name: "Chest X-Ray", price: 400, test_id: "CXR" },
    { name: "Urine Routine Examination", price: 150, test_id: "URE" }
];

async function seed() {
    try {
        await client.connect();
        console.log("Connected to DB...");
        const db = client.db("Hospital_crn");
        const patientsCollection = db.collection("patients");
        const testGroupsCollection = db.collection("testGroups");

        console.log("Seeding 20 assigned tests...");

        for (let i = 0; i < 20; i++) {
            // Create dummy patient
            const pid = `SEED-${Math.floor(Math.random() * 10000)}`;
            const patient = {
                pid: pid,
                name: `Test Patient ${i + 1}`,
                age: 20 + (i % 50),
                gender: i % 2 === 0 ? "Male" : "Female",
                phone: "01700000000",
                address: "Seed Address",
                testGroupIds: [],
                createdAt: new Date(),
                updatedAt: new Date()
            };

            const pResult = await patientsCollection.insertOne(patient);
            const patientId = pResult.insertedId;

            // Create test group
            const selectedTest = testMaster[i % testMaster.length];
            const testGroup = {
                patientId: patientId,
                pid: pid,
                tests: [{
                    test_id: selectedTest.test_id,
                    testName: selectedTest.name,
                    price: selectedTest.price,
                    discount: 0,
                    netAmount: selectedTest.price,
                    status: 'assigned'
                }],
                payment: 0,
                grandTotal: selectedTest.price,
                createdAt: new Date(),
                paymentStatus: "DUE"
            };

            const gResult = await testGroupsCollection.insertOne(testGroup);

            // Link group to patient
            await patientsCollection.updateOne(
                { _id: patientId },
                { $push: { testGroupIds: gResult.insertedId } }
            );
        }

        console.log("Seeding complete.");
    } catch (err) {
        console.error("Error seeding:", err);
    } finally {
        await client.close();
    }
}

seed();
