const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = `mongodb+srv://UserDB:${process.env.DB_PASS}@hospitalcrm.na1fsn2.mongodb.net/?retryWrites=true&w=majority&appName=HospitalCRM`
const client = new MongoClient(uri);

async function connectDB() {
  try {
    await client.connect();
    console.log("MongoDB Connected...");
    return client.db("Hospital_CRM");
  } catch (error) {
    console.error("MongoDB Connection Failed:", error);
  }
}

module.exports = connectDB;
