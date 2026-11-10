PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS products (
  abc TEXT PRIMARY KEY,

  description TEXT NOT NULL,

  ndc_original TEXT NOT NULL,

  ndc11 TEXT NOT NULL
    CHECK (
      length(ndc11) = 11
      AND ndc11 NOT GLOB '*[^0-9]*'
    ),

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
);

CREATE INDEX IF NOT EXISTS products_ndc
ON products(ndc11);


CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,

  request_id TEXT NOT NULL UNIQUE,

  request_hash TEXT NOT NULL,

  action TEXT NOT NULL
    CHECK (
      action IN ('RECEIVE', 'PULL', 'RETURN')
    ),

  gtin TEXT NOT NULL
    CHECK (
      length(gtin) = 14
    ),

  serial TEXT NOT NULL
    CHECK (
      length(serial) BETWEEN 1 AND 20
    ),

  lot TEXT NOT NULL
    CHECK (
      length(lot) BETWEEN 1 AND 20
    ),

  expiration TEXT NOT NULL,

  product_abc TEXT NOT NULL
    REFERENCES products(abc),

  raw_scan TEXT NOT NULL,

  created_at TEXT NOT NULL DEFAULT (
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  )
);

CREATE INDEX IF NOT EXISTS events_vial
ON events(gtin, serial, seq DESC);


CREATE TRIGGER IF NOT EXISTS validate_event
BEFORE INSERT ON events
BEGIN

  -- A vial can only be received once.
  -- Previously pulled vials must use RETURN instead.
  SELECT CASE
    WHEN NEW.action = 'RECEIVE'
      AND EXISTS (
        SELECT 1
        FROM events
        WHERE gtin = NEW.gtin
          AND serial = NEW.serial
      )
    THEN RAISE(
      ABORT,
      'Vial already received; use Return if appropriate'
    )
  END;

  -- PULL and RETURN require an existing vial.
  SELECT CASE
    WHEN NEW.action IN ('PULL', 'RETURN')
      AND NOT EXISTS (
        SELECT 1
        FROM events
        WHERE gtin = NEW.gtin
          AND serial = NEW.serial
      )
    THEN RAISE(
      ABORT,
      'Unknown vial; receive it first'
    )
  END;

  -- Only an In-stock vial can be pulled.
  SELECT CASE
    WHEN NEW.action = 'PULL'
      AND (
        SELECT action
        FROM events
        WHERE gtin = NEW.gtin
          AND serial = NEW.serial
        ORDER BY seq DESC
        LIMIT 1
      ) NOT IN ('RECEIVE', 'RETURN')
    THEN RAISE(
      ABORT,
      'Vial is already Out'
    )
  END;

  -- Only an Out vial can be returned.
  SELECT CASE
    WHEN NEW.action = 'RETURN'
      AND (
        SELECT action
        FROM events
        WHERE gtin = NEW.gtin
          AND serial = NEW.serial
        ORDER BY seq DESC
        LIMIT 1
      ) <> 'PULL'
    THEN RAISE(
      ABORT,
      'Vial is already In stock'
    )
  END;

  -- Preserve the identifiers assigned to the vial.
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM events
      WHERE gtin = NEW.gtin
        AND serial = NEW.serial
        AND (
          lot <> NEW.lot
          OR expiration <> NEW.expiration
          OR product_abc <> NEW.product_abc
        )
    )
    THEN RAISE(
      ABORT,
      'Vial identifiers conflict with its history'
    )
  END;

END;


CREATE TRIGGER IF NOT EXISTS events_no_update
BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(
    ABORT,
    'Activity is append-only'
  );
END;


CREATE TRIGGER IF NOT EXISTS events_no_delete
BEFORE DELETE ON events
BEGIN
  SELECT RAISE(
    ABORT,
    'Activity is append-only'
  );
END;


CREATE VIEW IF NOT EXISTS inventory AS
SELECT
  e.gtin,
  e.serial,
  e.lot,
  e.expiration,
  e.product_abc,
  p.description,
  p.ndc11,

  CASE
    WHEN e.action = 'PULL' THEN 'Out'
    ELSE 'In stock'
  END AS status,

  (
    SELECT MIN(r.created_at)
    FROM events r
    WHERE r.gtin = e.gtin
      AND r.serial = e.serial
  ) AS received_at,

  e.created_at AS last_action_at

FROM events e

JOIN products p
  ON p.abc = e.product_abc

WHERE e.seq = (
  SELECT MAX(r.seq)
  FROM events r
  WHERE r.gtin = e.gtin
    AND r.serial = e.serial
);
