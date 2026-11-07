// Reading Collector v0.2 —— 后台：把待推送条目存成 JSON 下载
const api = typeof browser !== "undefined" ? browser : chrome;

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== "download") return;
  try {
    const json = JSON.stringify(msg.payload, null, 1);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    api.downloads
      .download({
        url,
        filename: `reading-push-${stamp}.json`,
        saveAs: false,
        conflictAction: "uniquify",
      })
      .then((id) => {
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        sendResponse({ ok: true, id });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
  } catch (e) {
    sendResponse({ ok: false, error: String(e) });
  }
  return true;
});
