const { MongoClient } = require("mongodb");
require("dotenv").config();

const uri = `mongodb+srv://UserDB:${process.env.DB_PASS}@hospitalcrm.na1fsn2.mongodb.net/?retryWrites=true&w=majority&appName=HospitalCRM`;
const client = new MongoClient(uri);
const dbName = process.env.DB_NAME || "Hospital_crn";

async function connectDB() {
  try {
    await client.connect();
    console.log("MongoDB Connected...");
    return client.db(dbName);
  } catch (error) {
    console.error("MongoDB Connection Failed:", error);
    throw error;
  }
}


module.exports = connectDB;
