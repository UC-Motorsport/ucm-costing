import { readFile } from "node:fs/promises";
import path from "node:path";

import { verifyUcm25CompatiblePdf } from "../report/pdf-verifier";

const input = process.argv[2];
if (!input) {
  throw new Error("Usage: npm run verify:pdf -- <path-to-pdf>");
}

const absolutePath = path.resolve(input);
const bytes = await readFile(absolutePath);
console.log(
  JSON.stringify(
    await verifyUcm25CompatiblePdf(bytes, absolutePath),
    null,
    2,
  ),
);
