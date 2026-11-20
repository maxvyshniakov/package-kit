// Page command bridge extracted from Data Grid safari-real-bounce (5f3823488).
// Token-scoped commands replace WebDriver without activating the browser.
(() => {
  const token = document.currentScript?.dataset.token;
  const route = path => `/__stp-bounce/${path}?token=${token}`;
  const post = (path, body) => fetch(route(path), { method: "POST", body: JSON.stringify(body) }).catch(() => {});
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const commands = await (await fetch(route("cmd"), { cache: "no-store" })).json();
      for (const { id, js } of commands) {
        try { post("result", { id, value: await new Function(`return (async () => { ${js} })()`)() }); }
        catch (error) { post("result", { id, error: String(error?.stack ?? error) }); }
      }
    } catch { /* the runner is gone or the page is unloading */ }
    busy = false;
  }, 50);
})();
