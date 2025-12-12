async function getNextPID(countersCollection) {
  const result = await countersCollection.findOneAndUpdate(
    { _id: "patientId" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );

  const seqNumber = result?.seq ?? 1;
  return `P-${seqNumber.toString().padStart(3, "0")}`;
}

module.exports = { getNextPID };