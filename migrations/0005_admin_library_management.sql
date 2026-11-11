-- 0.4.0 ADDITIVE migration (Phase 1: library and package-alias management).
-- Run in the EXISTING D1 Console BEFORE deploying 0.4.0 code. Run each statement once, in order.
-- If an ALTER TABLE reports "duplicate column name", that statement already ran: skip it and continue.
-- Nothing here drops, rewrites or deletes inventory, events, lot_events, products or aliases.
ALTER TABLE products ADD COLUMN supplier_abc TEXT;
ALTER TABLE products ADD COLUMN archived_at TEXT;
ALTER TABLE products ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
UPDATE products SET supplier_abc=abc WHERE abc NOT LIKE 'MANUAL-%' AND supplier_abc IS NULL;
ALTER TABLE package_aliases ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE package_aliases ADD COLUMN disabled_at TEXT;
ALTER TABLE package_aliases ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now')), actor TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, reason TEXT NOT NULL CHECK(length(reason) BETWEEN 8 AND 500));
-- Execute each complete CREATE TRIGGER below as ONE statement (one line each).
CREATE TRIGGER IF NOT EXISTS admin_audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT,'Audit history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT,'Audit history is append-only'); END;
CREATE TRIGGER IF NOT EXISTS products_identity_immutable BEFORE UPDATE ON products WHEN NEW.abc<>OLD.abc OR NEW.ndc11<>OLD.ndc11 OR NEW.ndc_original<>OLD.ndc_original BEGIN SELECT RAISE(ABORT,'Internal key and NDC are immutable; archive the entry and add a new one'); END;
CREATE TRIGGER IF NOT EXISTS products_no_delete BEFORE DELETE ON products BEGIN SELECT RAISE(ABORT,'Library entries are archived, never deleted'); END;
CREATE TRIGGER IF NOT EXISTS events_no_receive_archived BEFORE INSERT ON events WHEN NEW.action='RECEIVE' AND EXISTS(SELECT 1 FROM products WHERE abc=NEW.product_abc AND archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Library entry is archived: new receipts are blocked'); END;
CREATE TRIGGER IF NOT EXISTS lot_events_no_receive_archived BEFORE INSERT ON lot_events WHEN NEW.action='RECEIVE' AND EXISTS(SELECT 1 FROM products WHERE abc=NEW.product_abc AND archived_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'Library entry is archived: new receipts are blocked'); END;
-- Verify afterwards: SELECT type,name FROM sqlite_master WHERE name LIKE '%archived%' OR name LIKE 'admin_audit%' OR name LIKE 'products_%';
