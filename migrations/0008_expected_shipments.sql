-- Migration 0008: expected shipments (packing slips). Planning data only: these tables never change inventory.
CREATE TABLE expected_shipments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  slip_date TEXT,
  counted_from TEXT NOT NULL,
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED','CANCELLED')),
  closed_at TEXT
);
CREATE TABLE expected_lines(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES expected_shipments(id),
  order_no TEXT NOT NULL DEFAULT '', box_id TEXT NOT NULL DEFAULT '', po TEXT NOT NULL DEFAULT '',
  storage TEXT NOT NULL DEFAULT '', item_no TEXT NOT NULL DEFAULT '',
  ndc11 TEXT NOT NULL CHECK(length(ndc11)=11 AND ndc11 NOT GLOB '*[^0-9]*'),
  description TEXT NOT NULL CHECK(length(description) BETWEEN 1 AND 300),
  lot TEXT NOT NULL DEFAULT '', expiration TEXT NOT NULL DEFAULT '',
  expected_qty INTEGER NOT NULL CHECK(expected_qty BETWEEN 1 AND 10000),
  vials_per_unit INTEGER NOT NULL DEFAULT 1 CHECK(vials_per_unit BETWEEN 1 AND 1000),
  flags TEXT NOT NULL DEFAULT ''
);
CREATE INDEX expected_lines_shipment ON expected_lines(shipment_id);
CREATE INDEX expected_shipments_status ON expected_shipments(status,id);
