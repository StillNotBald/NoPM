const fs=require("fs");let L=fs.readFileSync("r345.mjs","utf8").split("\n");
L=L.map(l=> l.includes('R4 CC awaiting') ? '{const x=await s.text(); console.log("R4 CC:", /awaiting/i.test(x), lines(x).join(" || "));}' : l.includes('R4 appr awaiting') ? '{const x=await s.text(); console.log("R4 appr:", /awaiting/i.test(x), lines(x).join(" || "));}' : l);
L.splice(2,0,'const lines=(x)=>x.split("\n").filter(l=>/awaiting|in review|your decision/i.test(l));');
fs.writeFileSync("r345.mjs",L.join("\n"));
