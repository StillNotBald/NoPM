import http from "node:http";
import fs from "node:fs";

const FILE = "<redacted-path>";

http
  .createServer((req, res) => {
    try {
      const html = fs.readFileSync(FILE, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  })
  .listen(8800, "127.0.0.1", () => console.log("serving theme-mock on http://127.0.0.1:8800"));
