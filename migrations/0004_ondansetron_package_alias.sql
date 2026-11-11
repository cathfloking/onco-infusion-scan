INSERT INTO package_aliases (
  gtin,
  product_abc,
  scanned_ndc11,
  unit_label,
  units_per_scan,
  source
)
SELECT
  '10360505613004',
  abc,
  '60505613000',
  'vial',
  1,
  'Individual vial scan verified by practice; DailyMed confirms 60505-6130-0 is the 2 mL vial and 60505-6130-5 is the carton of 25'
FROM products
WHERE ndc11 = '60505613005'
ORDER BY abc
LIMIT 1
ON CONFLICT(gtin) DO NOTHING;
