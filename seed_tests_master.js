const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

dotenv.config();

const uri = `mongodb+srv://UserDB:${process.env.DB_PASS}@hospitalcrm.na1fsn2.mongodb.net/?retryWrites=true&w=majority&appName=HospitalCRM`;
const client = new MongoClient(uri);

async function seedTests() {
    try {
        await client.connect();
        console.log("Connected to DB...");
        const db = client.db("Hospital_crn");
        const testsCollection = db.collection("tests");

        const testsDataPath = path.join(__dirname, "../Hospital_CRM_client/src/lab_test_master_expanded.json");
        const testsData = JSON.parse(fs.readFileSync(testsDataPath, "utf-8"));

        console.log(`Found ${testsData.length} tests to seed.`);

        // Clear existing tests or upsert? Let's clear for now to ensure consistency, as it's a master list
        // Or better, update if exists, insert if not. But clear is safer for master dictionary.
        const deleteResult = await testsCollection.deleteMany({});
        console.log(`Deleted ${deleteResult.deletedCount} existing tests.`);

        const insertResult = await testsCollection.insertMany(testsData);
        console.log(`Inserted ${insertResult.insertedCount} tests with room numbers.`);

    } catch (err) {
        console.error("Error seeding tests:", err);
    } finally {
        await client.close();
    }
}

seedTests();
