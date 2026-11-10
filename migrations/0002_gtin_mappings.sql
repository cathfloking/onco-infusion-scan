-- ADDITIVE update for the existing prototype schema. No table drops or inventory resets.
-- Run once in the existing D1 Console before deploying version 0.2.0.
CREATE TABLE IF NOT EXISTS gtin_mappings (
  gtin TEXT PRIMARY KEY CHECK(length(gtin)=14 AND gtin NOT GLOB '*[^0-9]*'),
  product_abc TEXT NOT NULL REFERENCES products(abc),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS gtin_mapping_product ON gtin_mappings(product_abc);
