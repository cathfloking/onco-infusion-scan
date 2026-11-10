// Oncology Infusion Scanner — browser-only prototype
//
// Required D1 binding:
//   DB
//
// Required secrets:
//   APP_USER
//   APP_PASSWORD
//
// Use ASCII-only credentials for this prototype.
// Do not store patient information.
//
// Public diagnostic endpoint:
//   GET /health
//
// All other application routes require authentication.

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });

function need(ok, message) {
  if (!ok) {
    throw new Error(message);
  }
}

async function digest(text) {
  const bytes = new TextEncoder().encode(text);

  const hash = await crypto.subtle.digest(
    "SHA-256",
    bytes
  );

  return Array.from(new Uint8Array(hash))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function authorized(request, env) {
  if (!env.APP_USER || !env.APP_PASSWORD) {
    return false;
  }

  const expected =
    "Basic " +
    btoa(env.APP_USER + ":" + env.APP_PASSWORD);

  const provided =
    request.headers.get("Authorization") || "";

  return (
    (await digest(provided)) ===
    (await digest(expected))
  );
}

function parseScan(input) {
  need(
    typeof input === "string" && input.length <= 512,
    "Scan must be text, at most 512 characters"
  );

  let remaining = input.replace(/[\r\n]+$/g, "");

  if (remaining.startsWith("]d2")) {
    remaining = remaining.slice(3);
  }

  const fields = {};

  while (remaining.length) {
    if (remaining[0] === "\x1d") {
      remaining = remaining.slice(1);
      continue;
    }

    const ai = remaining.slice(0, 2);
    remaining = remaining.slice(2);

    need(
      ["01", "17", "10", "21"].includes(ai),
      "Unsupported field or missing GS separator near AI " +
        ai
    );

    need(
      fields[ai] === undefined,
      "Duplicate barcode field " + ai
    );

    if (ai === "01" || ai === "17") {
      const length = ai === "01" ? 14 : 6;

      need(
        new RegExp("^\\d{" + length + "}").test(
          remaining
        ),
        "Invalid fixed-length field " + ai
      );

      fields[ai] = remaining.slice(0, length);
      remaining = remaining.slice(length);
    } else {
      const separatorPosition =
        remaining.indexOf("\x1d");

      fields[ai] =
        separatorPosition < 0
          ? remaining
          : remaining.slice(0, separatorPosition);

      remaining =
        separatorPosition < 0
          ? ""
          : remaining.slice(separatorPosition + 1);

      need(
        /^[\x21-\x7e]{1,20}$/.test(fields[ai]),
        "Invalid lot/serial or missing GS separator"
      );
    }
  }

  need(
    ["01", "17", "10", "21"].every(
      (key) => fields[key]
    ),
    "Need GTIN, expiration, lot and serial. " +
      "A GS separator may be missing after a " +
      "variable-length field."
  );

  let checkSum = 0;

  for (let index = 0; index < 13; index++) {
    checkSum +=
      Number(fields["01"][index]) *
      (index % 2 === 0 ? 3 : 1);
  }

  need(
    (10 - (checkSum % 10)) % 10 ===
      Number(fields["01"][13]),
    "GTIN check digit failed"
  );

  const yearDigits = Number(
    fields["17"].slice(0, 2)
  );

  const month = Number(
    fields["17"].slice(2, 4)
  );

  let day = Number(
    fields["17"].slice(4, 6)
  );

  // Prototype interpretation: years 2000–2099.
  const year = 2000 + yearDigits;

  need(
    month >= 1 && month <= 12,
    "Invalid expiration month"
  );

  const lastDayOfMonth = new Date(
    Date.UTC(year, month, 0)
  ).getUTCDate();

  if (day === 0) {
    day = lastDayOfMonth;
  }

  need(
    day >= 1 && day <= lastDayOfMonth,
    "Invalid expiration day"
  );

  return {
    gtin: fields["01"],
    serial: fields["21"],
    lot: fields["10"],
    expiration: [
      year,
      String(month).padStart(2, "0"),
      String(day).padStart(2, "0")
    ].join("-")
  };
}

function productRow(row, approved) {
  need(
    row && typeof row === "object",
    "Invalid library row"
  );

  const abc = String(row.abc || "").trim();

  const description = String(
    row.description || ""
  ).trim();

  const original = String(
    row.ndc || ""
  ).trim();

  need(
    /^\d{1,30}$/.test(abc),
    "Invalid ABC number"
  );

  need(
    description.length > 0 &&
      description.length <= 300,
    "Missing/overlong description"
  );

  let ndc = original;

  if (/^\d{1,5}-\d{1,4}-\d{1,2}$/.test(ndc)) {
    const parts = ndc.split("-");

    const pattern = parts
      .map((part) => part.length)
      .join("-");

    need(
      [
        "5-4-2",
        "4-4-2",
        "5-3-2",
        "5-4-1"
      ].includes(pattern),
      "Unsupported hyphenated NDC"
    );

    ndc = parts
      .map((part, index) =>
        part.padStart([5, 4, 2][index], "0")
      )
      .join("");
  } else {
    if (
      /^[0-9]+(?:\.[0-9]+)?[eE][+]?[0-9]+$/.test(
        ndc
      )
    ) {
      const value = Number(ndc);

      need(
        Number.isSafeInteger(value),
        "NDC scientific notation is not an exact integer"
      );

      ndc = String(value);
    }

    need(
      /^\d{1,11}$/.test(ndc),
      "NDC must contain at most 11 digits"
    );

    if (ndc.length < 11) {
      need(
        approved === true,
        "Short NDC: approve 11-digit source/" +
          "leading-zero restoration first"
      );

      ndc = ndc.padStart(11, "0");
    }
  }

  return {
    abc,
    description,
    ndc_original: original,
    ndc11: ndc
  };
}

export default {
  async fetch(request, env) {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY"
    };

    try {
      const url = new URL(request.url);

      // Public health check. Does not access D1 or secrets.
      if (
        request.method === "GET" &&
        url.pathname === "/health"
      ) {
        return json({
          ok: true,
          application: "onco-infusion-scan",
          version: "prototype-0.1.1"
        });
      }

      if (!env.APP_USER || !env.APP_PASSWORD) {
        return new Response(
          "Configure APP_USER and APP_PASSWORD " +
            "secrets before using this prototype.",
          {
            status: 503,
            headers
          }
        );
      }

      if (!(await authorized(request, env))) {
        return new Response("Sign in required", {
          status: 401,
          headers: {
            ...headers,
            "WWW-Authenticate":
              'Basic realm="Infusion scanner", ' +
              'charset="UTF-8"'
          }
        });
      }

      if (
        request.method === "GET" &&
        url.pathname === "/"
      ) {
        return new Response(PAGE, {
          headers: {
            ...headers,
            "Content-Type":
              "text/html; charset=utf-8",
            "Content-Security-Policy":
              "default-src 'self'; " +
              "script-src 'self' 'unsafe-inline' " +
              "https://cdn.sheetjs.com; " +
              "style-src 'unsafe-inline'; " +
              "connect-src 'self'; " +
              "object-src 'none'; " +
              "base-uri 'none'; " +
              "frame-ancestors 'none'"
          }
        });
      }

      need(
        env.DB,
        "Bind the D1 database as DB"
      );

      if (
        request.method === "GET" &&
        url.pathname === "/api/data"
      ) {
        const result = await env.DB.batch([
          env.DB.prepare(
            "SELECT * FROM products " +
              "ORDER BY description, abc"
          ),
          env.DB.prepare(
            "SELECT * FROM inventory " +
              "ORDER BY description, expiration, serial"
          ),
          env.DB.prepare(
            "SELECT * FROM events ORDER BY seq DESC"
          )
        ]);

        return json({
          products: result[0].results,
          inventory: result[1].results,
          activity: result[2].results
        });
      }

      if (request.method !== "POST") {
        return json(
          { error: "Not found" },
          404
        );
      }

      need(
        request.headers.get("Origin") === url.origin,
        "Cross-origin or missing-origin write rejected"
      );

      need(
        (
          request.headers.get("Content-Type") || ""
        ).startsWith("application/json"),
        "JSON required"
      );

      const text = await request.text();

      need(
        text.length <= 1000000,
        "Request exceeds prototype size limit"
      );

      const body = JSON.parse(text);

      if (url.pathname === "/api/parse") {
        return json(parseScan(body.raw));
      }

      if (url.pathname === "/api/import") {
        need(
          Array.isArray(body.rows) &&
            body.rows.length > 0 &&
            body.rows.length <= 2000,
          "Import 1-2000 rows"
        );

        const rows = body.rows.map((row) =>
          productRow(row, body.approvePadding)
        );

        const seen = new Map();

        for (const row of rows) {
          const previous = seen.get(row.abc);

          need(
            !previous ||
              (
                previous.description ===
                  row.description &&
                previous.ndc11 === row.ndc11
              ),
            "Conflicting duplicate ABC: " + row.abc
          );

          seen.set(row.abc, row);
        }

        const existingRows = (
          await env.DB.prepare(
            "SELECT * FROM products"
          ).all()
        ).results;

        const existingByABC = new Map(
          existingRows.map((row) => [
            row.abc,
            row
          ])
        );

        for (const row of rows) {
          const previous =
            existingByABC.get(row.abc);

          need(
            !previous ||
              (
                previous.description ===
                  row.description &&
                previous.ndc11 === row.ndc11
              ),
            "Existing ABC conflicts; " +
              "no changes imported: " +
              row.abc
          );
        }

        // Additive batches. A failure may leave earlier
        // batches imported. Existing rows are not replaced.
        let inserted = 0;

        for (
          let index = 0;
          index < rows.length;
          index += 50
        ) {
          const statements = rows
            .slice(index, index + 50)
            .map((row) =>
              env.DB.prepare(
                "INSERT INTO products " +
                  "(abc, description, ndc_original, ndc11) " +
                  "VALUES (?, ?, ?, ?) " +
                  "ON CONFLICT(abc) DO NOTHING"
              ).bind(
                row.abc,
                row.description,
                row.ndc_original,
                row.ndc11
              )
            );

          const results =
            await env.DB.batch(statements);

          inserted += results.reduce(
            (total, result) =>
              total + (result.meta.changes || 0),
            0
          );
        }

        return json({
          inserted,
          skipped: rows.length - inserted
        });
      }

      if (url.pathname === "/api/scan") {
        need(
          ["RECEIVE", "PULL", "RETURN"].includes(
            body.action
          ),
          "Invalid action"
        );

        need(
          typeof body.requestId === "string" &&
            /^[0-9a-f-]{36}$/i.test(
              body.requestId
            ),
          "Invalid request ID"
        );

        const parsed = parseScan(body.raw);

        const hash = await digest(
          JSON.stringify([
            body.raw,
            body.action,
            body.abc || ""
          ])
        );

        const previousRequest =
          await env.DB.prepare(
            "SELECT * FROM events " +
              "WHERE request_id = ?"
          )
            .bind(body.requestId)
            .first();

        if (previousRequest) {
          need(
            previousRequest.request_hash === hash,
            "Request ID reused with different content"
          );

          return json({
            saved: true,
            replayed: true,
            ...parsed
          });
        }

        const existingVial =
          await env.DB.prepare(
            "SELECT * FROM events " +
              "WHERE gtin = ? AND serial = ? " +
              "ORDER BY seq DESC LIMIT 1"
          )
            .bind(
              parsed.gtin,
              parsed.serial
            )
            .first();

        const abc = existingVial
          ? existingVial.product_abc
          : String(body.abc || "");

        if (!existingVial) {
          need(
            body.action === "RECEIVE",
            "Unknown vial; receive it first"
          );

          need(
            body.confirmProduct === true,
            "Confirm selected library product " +
              "matches the physical vial"
          );

          const product =
            await env.DB.prepare(
              "SELECT abc FROM products WHERE abc = ?"
            )
              .bind(abc)
              .first();

          need(
            product,
            "Choose a library product"
          );
        }

        // The database trigger validates the transition
        // during this single event insertion.
        await env.DB.prepare(
          "INSERT INTO events " +
            "(" +
            "request_id, request_hash, action, " +
            "gtin, serial, lot, expiration, " +
            "product_abc, raw_scan" +
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
          .bind(
            body.requestId,
            hash,
            body.action,
            parsed.gtin,
            parsed.serial,
            parsed.lot,
            parsed.expiration,
            abc,
            body.raw
          )
          .run();

        return json({
          saved: true,
          ...parsed
        });
      }

      return json(
        { error: "Not found" },
        404
      );
    } catch (error) {
      const message = String(
        error.message || error
      ).replace(/^D1_ERROR:\s*/, "");

      return json(
        { error: message },
        400
      );
    }
  }
};

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  >
  <title>Oncology Infusion Scanner</title>

  <script src="https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js"></script>

  <style>
    body {
      font: 16px system-ui;
      max-width: 1150px;
      margin: 24px auto;
      padding: 0 16px;
      color: #173244;
      background: #f5f8fa;
    }

    section {
      background: white;
      border: 1px solid #ccd9df;
      border-radius: 8px;
      padding: 18px;
      margin: 18px 0;
    }

    button,
    input,
    select {
      font: inherit;
      padding: 9px;
      margin: 5px 0;
      max-width: 100%;
      box-sizing: border-box;
    }

    button {
      cursor: pointer;
    }

    input[type="text"],
    select {
      width: 100%;
    }

    label {
      display: block;
      margin-top: 8px;
    }

    pre {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      background: #edf3f6;
      padding: 12px;
    }

    .scroll {
      overflow: auto;
      max-height: 440px;
    }

    table {
      border-collapse: collapse;
      width: 100%;
      font-size: 14px;
    }

    th,
    td {
      padding: 8px;
      border-bottom: 1px solid #ddd;
      text-align: left;
    }

    .ok {
      color: #075b39;
    }

    .error {
      color: #9b1525;
    }

    .notice {
      background: #fff3cd;
      padding: 12px;
    }
  </style>
</head>

<body>
  <h1>Oncology Infusion Scanner</h1>

  <p class="notice">
    Test prototype — no patient information.
    Shared sign-in; no individual user attribution.
    Expiration warnings do not block transactions.
  </p>

  <section>
    <h2>1. Drug library</h2>

    <input
      id="file"
      type="file"
      accept=".xlsx"
    >

    <label>
      <input id="pad" type="checkbox">
      I verified shortened numeric NDCs are
      11-digit-format values with leading zeros lost.
      Restore those zeros.
    </label>

    <button id="preview">Preview file</button>

    <button id="import" disabled>
      Import previewed rows
    </button>

    <pre id="previewText">Choose your Excel file, then preview.</pre>
  </section>

  <section>
    <h2>2. Scan</h2>

    <label>
      Action

      <select id="action">
        <option value="RECEIVE">Receive</option>
        <option value="PULL">Pull</option>
        <option value="RETURN">Return</option>
      </select>
    </label>

    <label>
      Library product — required for the first
      receipt of each new vial

      <select id="product">
        <option value="">Choose product</option>
      </select>
    </label>

    <label>
      <input id="confirm" type="checkbox">
      I verified the selected product matches
      the physical vial.
    </label>

    <form id="scanForm">
      <label>
        Scan here

        <input
          id="raw"
          type="text"
          autocomplete="off"
          spellcheck="false"
        >
      </label>

      <button type="submit">
        Save scan
      </button>

      <button
        type="button"
        id="diagnose"
      >
        Diagnose only
      </button>
    </form>

    <p id="status" role="status"></p>

    <details open>
      <summary>Scan diagnostics</summary>
      <pre id="diagnostic">No scan yet.</pre>
    </details>
  </section>

  <section>
    <h2>3. Inventory</h2>

    <button id="refresh">Refresh</button>
    <button id="export">Export Excel</button>

    <label>
      Search

      <input
        id="search"
        type="text"
        placeholder="Description, lot, serial, NDC..."
      >
    </label>

    <label>
      Status

      <select id="filter">
        <option value="">All</option>
        <option>In stock</option>
        <option>Out</option>
      </select>
    </label>

    <p id="count"></p>

    <div
      id="inventory"
      class="scroll"
    ></div>
  </section>

  <section>
    <h2>Recent activity</h2>

    <div
      id="activity"
      class="scroll"
    ></div>
  </section>

  <script>
    const $ = (id) =>
      document.getElementById(id);

    let data = {
      products: [],
      inventory: [],
      activity: []
    };

    let preview = [];
    let previewPadding = false;
    let pending = null;
    let busy = false;

    async function api(path, body) {
      const options =
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify(body)
            };

      const response = await fetch(
        path,
        options
      );

      const result = await response.json();

      if (!response.ok) {
        throw Error(
          result.error || "Request failed"
        );
      }

      return result;
    }

    function status(text, error = false) {
      $("status").textContent = text;

      $("status").className =
        error ? "error" : "ok";
    }

    function table(target, rows, columns) {
      const element =
        document.createElement("table");

      const heading =
        element.createTHead().insertRow();

      for (const key of columns) {
        const cell =
          document.createElement("th");

        cell.textContent = key;
        heading.append(cell);
      }

      const body = element.createTBody();

      for (const row of rows) {
        const tableRow = body.insertRow();

        for (const key of columns) {
          tableRow.insertCell().textContent =
            row[key] ?? "";
        }
      }

      $(target).replaceChildren(element);
    }

    function render() {
      const query =
        $("search").value.toLowerCase();

      const filter = $("filter").value;

      const rows = data.inventory.filter(
        (row) =>
          (!filter || row.status === filter) &&
          JSON.stringify(row)
            .toLowerCase()
            .includes(query)
      );

      table(
        "inventory",
        rows,
        [
          "description",
          "ndc11",
          "lot",
          "serial",
          "expiration",
          "status"
        ]
      );

      const inStockCount =
        data.inventory.filter(
          (row) => row.status === "In stock"
        ).length;

      $("count").textContent =
        rows.length +
        " vials displayed; " +
        inStockCount +
        " total In stock.";

      table(
        "activity",
        data.activity.slice(0, 100),
        [
          "created_at",
          "action",
          "gtin",
          "serial",
          "lot"
        ]
      );
    }

    async function refresh() {
      data = await api("/api/data");

      const selected =
        $("product").value;

      $("product").replaceChildren(
        new Option("Choose product", "")
      );

      for (const product of data.products) {
        $("product").add(
          new Option(
            product.description +
              " | " +
              product.ndc11 +
              " | ABC " +
              product.abc,
            product.abc
          )
        );
      }

      $("product").value = selected;

      render();
    }

    function identifier(value) {
      if (typeof value === "number") {
        if (
          !Number.isSafeInteger(value) ||
          value < 0
        ) {
          throw Error(
            "Invalid numeric identifier"
          );
        }

        return String(value);
      }

      return String(value ?? "").trim();
    }

    function normalizeNDC(value, approved) {
      let ndc = identifier(value);

      if (
        /^\\d+(?:\\.\\d+)?[eE][+]?\\d+$/.test(
          ndc
        )
      ) {
        const numeric = Number(ndc);

        if (!Number.isSafeInteger(numeric)) {
          throw Error(
            "Invalid scientific NDC"
          );
        }

        ndc = String(numeric);
      }

      if (ndc.includes("-")) {
        const parts = ndc.split("-");

        const pattern = parts
          .map((part) => part.length)
          .join("-");

        if (
          !parts.every(
            (part) => /^\\d+$/.test(part)
          ) ||
          ![
            "5-4-2",
            "4-4-2",
            "5-3-2",
            "5-4-1"
          ].includes(pattern)
        ) {
          throw Error(
            "Unsupported NDC pattern"
          );
        }

        return parts
          .map((part, index) =>
            part.padStart(
              [5, 4, 2][index],
              "0"
            )
          )
          .join("");
      }

      if (!/^\\d{1,11}$/.test(ndc)) {
        throw Error("Invalid NDC");
      }

      if (ndc.length < 11 && !approved) {
        throw Error(
          "Short NDC: review and approve " +
            "leading-zero restoration"
        );
      }

      return ndc.padStart(11, "0");
    }

    function clearPreview() {
      preview = [];
      $("import").disabled = true;
    }

    $("file").onchange = clearPreview;
    $("pad").onchange = clearPreview;

    $("preview").onclick = async () => {
      try {
        clearPreview();

        if (!window.XLSX) {
          throw Error(
            "Excel library did not load"
          );
        }

        const file = $("file").files[0];

        if (!file) {
          throw Error(
            "Choose an Excel file"
          );
        }

        if (file.size > 5000000) {
          throw Error(
            "Use a file below 5 MB"
          );
        }

        const workbook = XLSX.read(
          await file.arrayBuffer(),
          { type: "array" }
        );

        const worksheet =
          workbook.Sheets[
            workbook.SheetNames[0]
          ];

        const sourceRows =
          XLSX.utils.sheet_to_json(
            worksheet,
            {
              header: 1,
              raw: true,
              defval: ""
            }
          );

        if (!sourceRows.length) {
          throw Error(
            "The first worksheet is empty"
          );
        }

        const headers = sourceRows[0].map(
          (value) =>
            String(value)
              .replace(/\\s/g, "")
              .toLowerCase()
        );

        if (
          headers[0] !== "abc#" ||
          headers[1] !== "productdescription" ||
          headers[2] !== "ndc"
        ) {
          throw Error(
            "Expected columns A: ABC #, " +
              "B: Product Description, C: NDC"
          );
        }

        previewPadding =
          $("pad").checked;

        const seen = new Map();

        let duplicateRows = 0;

        const errors = [];
        const good = [];

        for (
          let index = 1;
          index < sourceRows.length;
          index++
        ) {
          const source = sourceRows[index];

          if (
            source.every(
              (value) => value === ""
            )
          ) {
            continue;
          }

          try {
            const row = {
              abc: identifier(source[0]),
              description: String(
                source[1]
              ).trim(),
              ndc: identifier(source[2])
            };

            if (
              !/^\\d{1,30}$/.test(row.abc) ||
              !row.description
            ) {
              throw Error(
                "Missing/invalid ABC or description"
              );
            }

            const normalized =
              normalizeNDC(
                row.ndc,
                previewPadding
              );

            if (seen.has(row.abc)) {
              const previous =
                seen.get(row.abc);

              if (
                previous.description !==
                  row.description ||
                previous.normalized !==
                  normalized
              ) {
                throw Error(
                  "Conflicting duplicate ABC " +
                    row.abc
                );
              }

              duplicateRows++;
              continue;
            }

            seen.set(row.abc, {
              description: row.description,
              normalized
            });

            const existing =
              data.products.find(
                (product) =>
                  product.abc === row.abc
              );

            if (
              existing &&
              (
                existing.description !==
                  row.description ||
                existing.ndc11 !== normalized
              )
            ) {
              throw Error(
                "Conflicting existing ABC " +
                  row.abc
              );
            }

            good.push({
              ...row,
              normalized
            });
          } catch (error) {
            errors.push(
              "Row " +
                (index + 1) +
                ": " +
                error.message
            );
          }
        }

        $("previewText").textContent =
          good.length +
          " unique valid rows; " +
          duplicateRows +
          " identical duplicates skipped; " +
          errors.length +
          " errors.\\n" +
          errors.slice(0, 30).join("\\n") +
          "\\nPreview:\\n" +
          JSON.stringify(
            good.slice(0, 8),
            null,
            2
          );

        if (
          !errors.length &&
          good.length
        ) {
          preview = good;

          $("import").disabled = false;
        }
      } catch (error) {
        $("previewText").textContent =
          error.message;
      }
    };

    $("import").onclick = async () => {
      if (!preview.length) {
        return;
      }

      $("import").disabled = true;

      try {
        const result = await api(
          "/api/import",
          {
            rows: preview,
            approvePadding:
              previewPadding
          }
        );

        $("previewText").textContent =
          "Imported " +
          result.inserted +
          "; skipped " +
          result.skipped;

        preview = [];

        await refresh();
      } catch (error) {
        $("previewText").textContent =
          error.message +
          " — refresh and preview again " +
          "before retrying.";
      }
    };

    function diagnostics(raw) {
      const visible = raw
        .replace(/\\x1d/g, "<GS>")
        .replace(/\\r/g, "<CR>")
        .replace(/\\n/g, "<LF>");

      const codes = Array.from(raw)
        .map(
          (character) =>
            character.charCodeAt(0)
        )
        .join(",");

      $("diagnostic").textContent =
        "Raw: " +
        visible +
        "\\nCharacter codes: " +
        codes;
    }

    $("diagnose").onclick = async () => {
      const raw = $("raw").value;

      diagnostics(raw);

      try {
        const parsed = await api(
          "/api/parse",
          { raw }
        );

        $("diagnostic").textContent +=
          "\\nParsed: " +
          JSON.stringify(
            parsed,
            null,
            2
          );

        status(
          "Parsed only; inventory unchanged."
        );
      } catch (error) {
        status(
          error.message,
          true
        );
      }
    };

    $("scanForm").onsubmit = async (
      event
    ) => {
      event.preventDefault();

      if (busy) {
        return;
      }

      const raw = $("raw").value;

      diagnostics(raw);

      const base = {
        raw,
        action: $("action").value,
        abc: $("product").value,
        confirmProduct:
          $("confirm").checked
      };

      const signature =
        JSON.stringify(base);

      if (
        !pending ||
        pending.signature !== signature
      ) {
        pending = {
          signature,
          id: crypto.randomUUID()
        };
      }

      busy = true;

      try {
        const parsed = await api(
          "/api/scan",
          {
            ...base,
            requestId: pending.id
          }
        );

        $("diagnostic").textContent +=
          "\\nSaved: " +
          JSON.stringify(
            parsed,
            null,
            2
          );

        $("raw").value = "";
        pending = null;

        const today = new Date()
          .toISOString()
          .slice(0, 10);

        const warning =
          parsed.expiration < today
            ? "WARNING: manufacturer " +
              "expiration is in the past."
            : "";

        status(
          base.action +
          " saved. " +
          warning
        );

        try {
          await refresh();
        } catch (error) {
          status(
            "Scan saved, but refresh failed. " +
              "Do not scan again; use Refresh.",
            true
          );
        }
      } catch (error) {
        status(
          error.message +
            " — not confirmed saved. " +
            "Keep this scan unchanged " +
            "to retry safely.",
          true
        );
      } finally {
        busy = false;
        $("raw").focus();
      }
    };

    $("action").onchange = () => {
      $("raw").focus();
    };

    $("product").onchange = () => {
      $("confirm").checked = false;
    };

    $("search").oninput = render;
    $("filter").onchange = render;

    $("refresh").onclick = () => {
      refresh().catch((error) =>
        status(
          error.message,
          true
        )
      );
    };

    $("export").onclick = async () => {
      try {
        if (!window.XLSX) {
          throw Error(
            "Excel library did not load"
          );
        }

        await refresh();

        const workbook =
          XLSX.utils.book_new();

        const sheets = [
          [
            "Inventory",
            data.inventory
          ],
          [
            "Activity",
            data.activity
          ],
          [
            "Drug Library",
            data.products
          ]
        ];

        for (const [name, rows] of sheets) {
          const worksheet =
            XLSX.utils.json_to_sheet(rows);

          XLSX.utils.book_append_sheet(
            workbook,
            worksheet,
            name
          );
        }

        const date = new Date()
          .toISOString()
          .slice(0, 10);

        XLSX.writeFile(
          workbook,
          "Oncology-Inventory-" +
            date +
            ".xlsx"
        );
      } catch (error) {
        status(
          error.message,
          true
        );
      }
    };

    refresh().catch((error) =>
      status(
        error.message,
        true
      )
    );
  </script>
</body>
</html>`;
