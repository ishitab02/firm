#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const inputPath = process.env.MARKETPLACE_SCAN_JSON;
const outputPath = process.env.VENDOR_INDEX_OUT ?? "data/vendor-index.json";

if (!inputPath) {
  console.error(
    "TODO(unverified): set MARKETPLACE_SCAN_JSON to a real marketplace scanner output before generating vendor-index.json."
  );
  process.exit(2);
}

const scan = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const vendors = Array.isArray(scan) ? scan : scan.vendors;
if (!Array.isArray(vendors)) {
  throw new Error("marketplace scan must be an array or { vendors: [...] }");
}

const indexed = vendors.map((vendor) => ({
  agent_id: String(vendor.agent_id),
  name: String(vendor.name),
  endpoint: String(vendor.endpoint),
  services: (vendor.services ?? []).map((service) => ({
    tool: String(service.tool),
    price: service.price,
    capability: String(service.capability)
  })),
  kya_base_score: Number(vendor.kya_base_score ?? vendor.score ?? 0),
  flags: vendor.flags ?? [],
  last_verified_at: vendor.last_verified_at ?? new Date().toISOString()
}));

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  JSON.stringify({ generated_at: new Date().toISOString(), vendors: indexed }, null, 2) + "\n"
);
console.log(`wrote ${indexed.length} vendors to ${outputPath}`);
