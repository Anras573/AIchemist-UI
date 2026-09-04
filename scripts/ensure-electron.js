// Recent Electron releases no longer download their binary via a package
// "postinstall" script. Instead, the download happens lazily the first time
// something does `require('electron')` (see node_modules/electron/index.js).
//
// bun (and other package managers that skip dependency lifecycle scripts by
// default) never trigger that require, and neither does electron-vite's own
// `dev`/`preview` commands, which resolve the Electron binary path directly
// instead of requiring the package. Without this, `bun run start`/`bun run
// dev` fail with "Error: Electron uninstall" because the binary was never
// downloaded.
//
// Requiring electron here, as part of our own postinstall step, forces the
// download so the binary is present before electron-vite tries to spawn it.
require('electron')
