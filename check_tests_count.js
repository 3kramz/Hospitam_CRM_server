
const { MongoClient } = require("mongodb");
require("dotenv").config();

// Construct URI as per check_admin.js
const uri = `mongodb+srv://UserDB:${process.env.DB_PASS}@hospitalcrm.na1fsn2.mongodb.net/?retryWrites=true&w=majority&appName=HospitalCRM`;

async function run() {
    const client = new MongoClient(uri);
    try {
        await client.connect();
        console.log("Connected to DB...");
        const db = client.db("Hospital_crn"); // Matching check_admin.js
        const count = await db.collection("tests").countDocuments();
        console.log(`Total tests found: ${count}`);

        if (count > 0) {
            const tests = await db.collection("tests").find().limit(5).toArray();
            console.log("Sample tests:", tests);
        } else {
            console.log("No tests found in 'tests' collection.");
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await client.close();
    }
}

run();
