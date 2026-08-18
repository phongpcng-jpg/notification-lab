import { migrate, closeDb } from "../src/db/index.js";

migrate();
console.log("[migrate] Schema applied successfully.");
closeDb();
