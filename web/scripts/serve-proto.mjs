import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "mainline-prototype.html");
createServer((req, res) => {
  if (req.url && req.url.includes("favicon")) { res.writeHead(404, { "connection": "close" }); res.end(); return; }
  const buf = Buffer.from(readFileSync(file, "utf8"), "utf8");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": buf.length, "connection": "close" });
  res.end(buf);
}).listen(8801, "127.0.0.1", () => console.log("serving on http://127.0.0.1:8801"));
