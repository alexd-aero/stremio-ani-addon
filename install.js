/**
 * Opens the stremio:// protocol handler so Stremio registers this local
 * add-on with one click.  Run AFTER `npm start` is already serving.
 *
 *   node install.js
 *
 * (Windows uses `cmd /c start`, macOS `open`, Linux `xdg-open`.)
 */
const { exec } = require("child_process");

const PORT = process.env.PORT ? Number(process.env.PORT) : 7000;
const deepLink = `stremio://127.0.0.1:${PORT}/manifest.json`;

const platform = process.platform;
let cmd;
if (platform === "win32") cmd = `cmd /c start "" "${deepLink}"`;
else if (platform === "darwin") cmd = `open "${deepLink}"`;
else cmd = `xdg-open "${deepLink}"`;

console.log(`Opening Stremio with: ${deepLink}`);
exec(cmd, (err) => {
  if (err) {
    console.error("Could not auto-open Stremio. Paste this into Stremio's");
    console.error("search / add-on bar manually:");
    console.error("  " + deepLink);
    console.error("(or the web URL: http://127.0.0.1:" + PORT + "/manifest.json)");
    process.exit(1);
  }
  console.log("Stremio should now prompt you to install the add-on.");
});
