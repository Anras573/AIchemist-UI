import { dialog } from "electron";

/**
 * Show a native "Open Folder" dialog.
 * Returns the selected directory path, or null if the user cancelled.
 */
export async function openFolderDialog(): Promise<string | null> {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Open Project Folder",
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
}
