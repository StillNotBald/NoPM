import { open, BASE } from "./lib.mjs";
const [role, path, w] = [process.argv[2], process.argv[3], +(process.argv[4]||390)];
const s = await open(role, w, w>600?800:844);
await s.page.goto(BASE + "/" + path, { waitUntil: "load", timeout: 90000 });
await s.page.waitForTimeout(3500); console.log(s.page.url());
console.log((await s.text()).slice(0, 3500));
if (process.argv[5]) await s.shot(process.argv[5]);
await s.browser.close();
