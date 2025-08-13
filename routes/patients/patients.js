const express = require("express");

module.exports = (db, verifyToken) => {
    const router = express.Router();
    const patientsCollection = db.collection("patients");

    router.get("/search", async (req, res) => {
        try {
            const q = req.query.q?.trim();
            if (!q) return res.json([]);

            const regex = new RegExp(q, "i"); // case-insensitive

            // Search by name OR patient id (pid)
            const patients = await patientsCollection
                .find({
                    $or: [
                        { name: { $regex: regex } },
                        { pid: { $regex: regex } }
                    ]
                })
                .limit(30)
                .toArray();

            res.json(patients);
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: "Failed to search patients" });
        }
    });

    
    return router;
};
