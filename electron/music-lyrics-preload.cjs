// The desktop lyric strip's preload: it forwards a double-click to the main process
// so the strip can be locked or unlocked without any node access in the page.
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  document.addEventListener("dblclick", () => ipcRenderer.send("music-lyrics:toggle-lock"));
});
