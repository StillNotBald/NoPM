// exports pickCard(page, key): returns the Locator of the narrowest container holding `key` text and an Approve button
export async function pickCard(p, key, btnRe = /^approve/i) {
  const handle = await p.evaluateHandle(([key]) => {
    const btns = [...document.querySelectorAll("button")].filter((b) => /^approve/i.test(b.innerText.trim()) && b.offsetParent);
    for (const b of btns) {
      let el = b;
      for (let i = 0; i < 8 && el; i++) {
        el = el.parentElement;
        if (el && /Reason:/.test(el.innerText)) { if (el.innerText.includes(key)) return b; break; }
      }
    }
    return null;
  }, [key]);
  return handle.asElement();
}
