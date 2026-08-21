import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "src/db/schema.sql");
const destination = resolve(root, "dist/src/db/schema.sql");

mkdirSync(dirname(destination), { recursive: true });
copyFileSync(source, destination);
console.log(`Copied schema.sql -> ${destination}`);
