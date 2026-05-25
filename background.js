async function getOpenEditor(urlFragment) {
  const baseUrl = browser.runtime.getURL(urlFragment);
  const popups = await browser.windows.getAll({
    populate: true,
    windowTypes: ["popup"],
  });
  return popups.find((p) => p.tabs?.[0]?.url?.startsWith(baseUrl));
}

async function openEditor(url, info, tab) {
  const { messages } = info.selectedMessages;
  if (messages.length != 1) return;
  if (await getOpenEditor("/editor/")) return;

  if (info.menuItemId == "hdrtools-edit")
  browser.windows.create({
    type: "popup",
    height: 416,
    width: 832,
    url: url + "?tabId=" + tab.id + "&messageId=" + messages[0].id,
    allowScriptsToClose: true,
  });
  else
  browser.windows.create({
    type: "popup",
    height: 640,
    width: 960,
    url: url + "?tabId=" + tab.id + "&messageId=" + messages[0].id,
    allowScriptsToClose: true,
  });
}

async function init() {
  // Disable the menu entries if not exactly one message is selected
  // or an editor window is already open.
  browser.menus.onShown.addListener(async (info) => {
    if (
      !info.menuIds.includes("hdrtools-edit") &&
      !info.menuIds.includes("hdrtools-editFS")
    )
      return;

    const { messages } = info.selectedMessages;
    const editorOpen = await getOpenEditor("/editor/");
    const enabled = !editorOpen && messages.length == 1;
    await browser.menus.update("hdrtools-edit", { enabled });
    await browser.menus.update("hdrtools-editFS", { enabled });
    await browser.menus.refresh();
  });

  browser.menus.create({
    id: "hdrtools-edit",
    title: browser.i18n.getMessage("changeDetails"),
    contexts: ["message_list"],
  });

  browser.menus.create({
    id: "hdrtools-editFS",
    title: browser.i18n.getMessage("fullSource"),
    contexts: ["message_list"],
  });

  browser.menus.create({
    id: "hdrtools-options",
    title: browser.i18n.getMessage("prefTitle"),
    contexts: ["message_list"],
  });

  browser.menus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId == "hdrtools-edit")
      await openEditor("/editor/headers.html", info, tab);
    else if (info.menuItemId == "hdrtools-editFS")
      await openEditor("/editor/source.html", info, tab);
    else if (info.menuItemId == "hdrtools-options")
      browser.runtime.openOptionsPage();
  });

  // Keyboard shortcuts
  browser.commands.onCommand.addListener(async (command) => {
    const tabs = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tabs.length) return;
    const tab = tabs[0];

    try {
      await browser.mailTabs.get(tab.id);
    } catch {
      return; // not a mail tab
    }

    const list = await browser.mailTabs.getSelectedMessages(tab.id);
    if (!list || list.messages.length != 1) return;

    const info = { selectedMessages: list };
    if (command == "edit-headers")
      await openEditor("/editor/headers.html", info, tab);
    else if (command == "edit-source")
      await openEditor("/editor/source.html", info, tab);
  });

  await applyShortcuts();
}

async function applyShortcuts() {
  const { edit_shortcut, editFS_shortcut } = await browser.storage.local.get({
    edit_shortcut: "",
    editFS_shortcut: "",
  });
  if (edit_shortcut)
    await browser.commands.update({
      name: "edit-headers",
      //shortcut: "Shift+" + edit_shortcut.toUpperCase(),
    });
  else await browser.commands.reset("edit-headers");

  if (editFS_shortcut)
    await browser.commands.update({
      name: "edit-source",
      //shortcut: "Shift+" + editFS_shortcut.toUpperCase(),
    });
  else await browser.commands.reset("edit-source");
}

// Re-apply shortcuts when the user changes them in the options
browser.storage.onChanged.addListener((changes, area) => {
  if (area == "local" && (changes.edit_shortcut || changes.editFS_shortcut))
    applyShortcuts();
});

// Migrate preferences from the old nsIPrefBranch system to browser.storage.local.
// Uses the LegacyPrefs experiment API to read old values, then clears them.
async function migrateLegacyPrefs() {
  const { prefs_migrated } = await browser.storage.local.get({
    prefs_migrated: false,
  });
  if (prefs_migrated) return;

  const BRANCH = "extensions.hdrtoolsimproved.";
  const PREFS = [
    { old: "putOriginalInTrash", type: "bool" },
    { old: "use_imap_fix", type: "bool" },
    { old: "add_htl_header", type: "bool" },
    { old: "fullsource_maxchars", type: "int" },
    { old: "edit_shortcut", type: "string" },
    { old: "editFS_shortcut", type: "string" },
  ];

  for (const pref of PREFS) {
    const value = await browser.LegacyPrefs.getUserPref(BRANCH + pref.old);
    if (value !== null) await browser.storage.local.set({ [pref.old]: value });
  }

  // Clean up old prefs
  for (const pref of PREFS)
    browser.LegacyPrefs.clearUserPref(BRANCH + pref.old);
  browser.LegacyPrefs.clearUserPref(BRANCH + "editFullSourceWarning");
  browser.LegacyPrefs.clearUserPref(BRANCH + "prefs_migrated");

  await browser.storage.local.set({ prefs_migrated: true });
  console.log("Header Tools Improved: legacy preferences migrated");
}

async function main() {
  await migrateLegacyPrefs();
  await init();
}

main();
