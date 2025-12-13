
const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");
dotenv.config();

const uri = `mongodb+srv://UserDB:${process.env.DB_PASS}@hospitalcrm.na1fsn2.mongodb.net/?retryWrites=true&w=majority&appName=HospitalCRM`;
const client = new MongoClient(uri);

async function checkAdmin() {
    try {
        await client.connect();
        console.log("Connected to DB...");
        const db = client.db("Hospital_crn");
        const usersCollection = db.collection("users");

        const user = await usersCollection.findOne({ email: "admin@hospitam.com" });
        console.log("Admin User Data:", user);

        // Also check if there are any other admins
        const allAdmins = await usersCollection.find({ role: { $regex: /^admin$/i } }).toArray();
        console.log("All Admins found:", allAdmins);

    } catch (err) {
        console.error("Error:", err);
    } finally {
        await client.close();
    }
}

checkAdmin();
