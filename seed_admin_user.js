
const { MongoClient } = require("mongodb");
const dotenv = require("dotenv");
dotenv.config();

const uri = `mongodb+srv://UserDB:${process.env.DB_PASS}@hospitalcrm.na1fsn2.mongodb.net/?retryWrites=true&w=majority&appName=HospitalCRM`;
const client = new MongoClient(uri);

async function seedAdmin() {
    try {
        await client.connect();
        console.log("Connected to DB...");
        const db = client.db("Hospital_crn");
        const usersCollection = db.collection("users");

        const adminUser = {
            name: "Admin User",
            email: "admin@hospitam.com", // The email user is likely using
            role: "admin",
            createdAt: new Date(),
            photo: "https://i.ibb.co/4pDNDk1/avatar.png"
        };

        const result = await usersCollection.updateOne(
            { email: adminUser.email },
            { $set: adminUser },
            { upsert: true }
        );

        console.log("Admin user seeded/updated:", result);

    } catch (err) {
        console.error("Error seeding admin:", err);
    } finally {
        await client.close();
    }
}

seedAdmin();
