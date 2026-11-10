-- 0.3.0 ADDITIVE migration. Run in the EXISTING D1 database before code deployment.
-- Keep all old tables, triggers, events and view. No original schema rerun is needed.
CREATE TABLE IF NOT EXISTS package_aliases (
 gtin TEXT PRIMARY KEY CHECK(length(gtin)=14 AND gtin NOT GLOB '*[^0-9]*'),
 product_abc TEXT NOT NULL REFERENCES products(abc),
 scanned_ndc11 TEXT NOT NULL CHECK(length(scanned_ndc11)=11 AND scanned_ndc11 NOT GLOB '*[^0-9]*'),
 unit_label TEXT NOT NULL DEFAULT 'vial',
 units_per_scan INTEGER NOT NULL DEFAULT 1 CHECK(units_per_scan=1),
 source TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS event_packages (
 event_seq INTEGER PRIMARY KEY REFERENCES events(seq),
 scanned_ndc11 TEXT,
 supplier_ndc11 TEXT NOT NULL,
 parse_mode TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS lot_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,
 request_id TEXT NOT NULL UNIQUE,
 request_hash TEXT NOT NULL,
 action TEXT NOT NULL CHECK(action IN('RECEIVE','PULL','RETURN')),
 gtin TEXT NOT NULL CHECK(length(gtin)=14),
 lot TEXT NOT NULL CHECK(length(lot) BETWEEN 1 AND 20),
 expiration TEXT NOT NULL,
 product_abc TEXT NOT NULL REFERENCES products(abc),
 scanned_ndc11 TEXT,
 supplier_ndc11 TEXT NOT NULL,
 quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity=1),
 raw_scan TEXT NOT NULL,
 parse_mode TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS lot_events_bucket ON lot_events(gtin,lot,expiration,seq);
-- Execute each complete CREATE TRIGGER below as one statement if your Console splits scripts.
CREATE TRIGGER IF NOT EXISTS lot_events_validate BEFORE INSERT ON lot_events BEGIN SELECT RAISE(ABORT,'No matching vial is In stock') WHERE NEW.action='PULL' AND COALESCE((SELECT SUM(CASE WHEN action='PULL' THEN -1 ELSE 1 END) FROM lot_events WHERE gtin=NEW.gtin AND lot=NEW.lot AND expiration=NEW.expiration),0)<1; SELECT RAISE(ABORT,'No matching pulled vial is available to Return') WHERE NEW.action='RETURN' AND COALESCE((SELECT SUM(CASE WHEN action='PULL' THEN 1 WHEN action='RETURN' THEN -1 ELSE 0 END) FROM lot_events WHERE gtin=NEW.gtin AND lot=NEW.lot AND expiration=NEW.expiration),0)<1; SELECT RAISE(ABORT,'Lot group product association conflicts with its history') WHERE EXISTS(SELECT 1 FROM lot_events WHERE gtin=NEW.gtin AND lot=NEW.lot AND expiration=NEW.expiration AND (product_abc<>NEW.product_abc OR supplier_ndc11<>NEW.supplier_ndc11 OR scanned_ndc11 IS NOT NEW.scanned_ndc11)); END;
CREATE TRIGGER IF NOT EXISTS lot_events_no_update BEFORE UPDATE ON lot_events BEGIN SELECT RAISE(ABORT,'Lot activity is append-only'); END;
CREATE TRIGGER IF NOT EXISTS lot_events_no_delete BEFORE DELETE ON lot_events BEGIN SELECT RAISE(ABORT,'Lot activity is append-only'); END;
CREATE TRIGGER IF NOT EXISTS event_packages_no_update BEFORE UPDATE ON event_packages BEGIN SELECT RAISE(ABORT,'Recorded package identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS event_packages_no_delete BEFORE DELETE ON event_packages BEGIN SELECT RAISE(ABORT,'Recorded package identity is immutable'); END;
-- Verified 5 mL individual vial -> 25 x 5 mL supplier tray.
-- Source: Fresenius Kabi labeling, DailyMed setid 5bf47be3-f3fe-452b-8113-941796498345.
-- Does not multiply a scan by the supplier carton size.
INSERT INTO package_aliases(gtin,product_abc,scanned_ndc11,unit_label,units_per_scan,source)
SELECT '00363323884017',abc,'63323088401','vial',1,'Fresenius Kabi DailyMed labeling: 63323-884-01 each; 63323-884-06 tray'
FROM products WHERE ndc11='63323088406' ORDER BY abc LIMIT 1
ON CONFLICT(gtin) DO NOTHING;
