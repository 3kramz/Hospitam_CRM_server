async function getNextPID(countersCollection) {
  const result = await countersCollection.findOneAndUpdate(
    { _id: "patientId" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );

  const seqNumber = result?.seq ?? 1;
  return `P-${seqNumber.toString().padStart(3, "0")}`;
}

async function getNextInvoiceID(countersCollection) {
  const result = await countersCollection.findOneAndUpdate(
    { _id: "invoiceId" },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: "after" }
  );

  const seqNumber = result?.seq ?? 1;
  // Base36 conversion (0-9, a-z)
  const base36 = seqNumber.toString(36).toUpperCase();
  // Pad to 6 chars
  return base36.padStart(6, "0");
}

module.exports = { getNextPID, getNextInvoiceID };