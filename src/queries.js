export const SERIAL_INVENTORY=`SELECT 'serialized' AS tracking_mode,e.gtin,e.serial,e.lot,e.expiration,e.product_abc,p.description,p.ndc11,
 x.scanned_ndc11,COALESCE(x.supplier_ndc11,p.ndc11) AS supplier_ndc11,
 CASE WHEN e.action='PULL' THEN 0 ELSE 1 END AS in_stock,
 CASE WHEN e.action='PULL' THEN 1 ELSE 0 END AS out_quantity,
 1 AS received_quantity,e.action AS last_action,e.created_at AS last_action_at,
 s.scanned_in_at,s.last_scanned_out_at,s.last_returned_at,s.pull_count,s.return_count
 FROM events e JOIN products p ON p.abc=e.product_abc LEFT JOIN event_packages x ON x.event_seq=e.seq
 JOIN (SELECT gtin,serial,MIN(CASE WHEN action='RECEIVE' THEN created_at END) AS scanned_in_at,
 MAX(CASE WHEN action='PULL' THEN created_at END) AS last_scanned_out_at,
 MAX(CASE WHEN action='RETURN' THEN created_at END) AS last_returned_at,
 SUM(CASE WHEN action='PULL' THEN 1 ELSE 0 END) AS pull_count,
 SUM(CASE WHEN action='RETURN' THEN 1 ELSE 0 END) AS return_count FROM events GROUP BY gtin,serial) s ON s.gtin=e.gtin AND s.serial=e.serial
 WHERE e.seq=(SELECT MAX(r.seq) FROM events r WHERE r.gtin=e.gtin AND r.serial=e.serial)`;
export const LOT_INVENTORY=`SELECT 'nonserialized' AS tracking_mode,e.gtin,NULL AS serial,e.lot,e.expiration,e.product_abc,p.description,p.ndc11,
 e.scanned_ndc11,e.supplier_ndc11,s.in_stock,s.out_quantity,s.received_quantity,e.action AS last_action,e.created_at AS last_action_at,
 s.scanned_in_at,s.last_scanned_out_at,s.last_returned_at,s.pull_count,s.return_count
 FROM lot_events e JOIN products p ON p.abc=e.product_abc
 JOIN (SELECT gtin,lot,expiration,SUM(CASE WHEN action='PULL' THEN -1 ELSE 1 END) AS in_stock,
 SUM(CASE WHEN action='PULL' THEN 1 WHEN action='RETURN' THEN -1 ELSE 0 END) AS out_quantity,
 SUM(CASE WHEN action='RECEIVE' THEN 1 ELSE 0 END) AS received_quantity,
 MIN(CASE WHEN action='RECEIVE' THEN created_at END) AS scanned_in_at,
 MAX(CASE WHEN action='PULL' THEN created_at END) AS last_scanned_out_at,
 MAX(CASE WHEN action='RETURN' THEN created_at END) AS last_returned_at,
 SUM(CASE WHEN action='PULL' THEN 1 ELSE 0 END) AS pull_count,
 SUM(CASE WHEN action='RETURN' THEN 1 ELSE 0 END) AS return_count FROM lot_events GROUP BY gtin,lot,expiration) s
 ON s.gtin=e.gtin AND s.lot=e.lot AND s.expiration=e.expiration
 WHERE e.seq=(SELECT MAX(r.seq) FROM lot_events r WHERE r.gtin=e.gtin AND r.lot=e.lot AND r.expiration=e.expiration)`;
export const SERIAL_ACTIVITY=`SELECT 'serialized' AS tracking_mode,e.*,x.scanned_ndc11,COALESCE(x.supplier_ndc11,p.ndc11) AS supplier_ndc11,x.parse_mode,p.description,p.ndc11,1 AS quantity FROM events e JOIN products p ON p.abc=e.product_abc LEFT JOIN event_packages x ON x.event_seq=e.seq`;
export const LOT_ACTIVITY=`SELECT 'nonserialized' AS tracking_mode,e.*,NULL AS serial,p.description,p.ndc11 FROM lot_events e JOIN products p ON p.abc=e.product_abc`;
