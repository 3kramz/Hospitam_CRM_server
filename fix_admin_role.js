
const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");
dotenv.config();

const uri = `mongodb+srv://UserDB:${process.env.DB_PASS}@hospitalcrm.na1fsn2.mongodb.net/?retryWrites=true&w=majority&appName=HospitalCRM`;
const client = new MongoClient(uri);

async function fixAdmin() {
    try {
        await client.connect();
        console.log("Connected to DB...");
        const db = client.db("Hospital_crn");
        const usersCollection = db.collection("users");

        const result = await usersCollection.updateOne(
            { email: "admin@hospitam.com" },
            { $set: { role: "admin" } }
        );

        console.log("Admin role forced to 'admin':", result);

        const check = await usersCollection.findOne({ email: "admin@hospitam.com" });
        console.log("Verification:", check);

    } catch (err) {
        console.error("Error:", err);
    } finally {
        await client.close();
    }
}

fixAdmin();
