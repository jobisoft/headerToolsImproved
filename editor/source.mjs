import { getPref } from "../options/defaults.mjs";
import { localizeDocument } from "../vendor/i18n.mjs";
import {
  cleanCRLF,
  addHTLHeader,
  applyImapFix,
  getOrigDate,
  getRawFile,
  replaceMessage,
} from "./messageOps.mjs";

let messageId;
let tabId;
let fullRawSource;
let origDate;
let charLimit;
let isImap;

async function init() {
  localizeDocument();

  const params = new URLSearchParams(window.location.search);
  messageId = parseInt(params.get("messageId"));
  tabId = parseInt(params.get("tabId"));

  document.getElementById("btn_save").addEventListener("click", save);
  document
    .getElementById("btn_cancel")
    .addEventListener("click", () => window.close());
  document
    .getElementById("btn_showFull")
    .addEventListener("click", showFullSource);

  // Show warning on first use, with option to suppress
  const { editFullSourceWarning } = await browser.storage.local.get({
    editFullSourceWarning: true,
  });
  if (editFullSourceWarning) {
    const msg = messenger.i18n.getMessage("fsWarning");
    const suppress = confirm(
      msg + "\n\n" + messenger.i18n.getMessage("dontShowAgain"),
    );
    if (suppress)
      await browser.storage.local.set({ editFullSourceWarning: false });
  }

  const rawFile = await getRawFile(messageId);
  fullRawSource = await rawFile.text();
  const hdr = await messenger.messages.get(messageId);

  try {
    const account = await messenger.accounts.get(hdr.folder?.accountId, false);
    isImap = account?.type === "imap";
  } catch (e) {
    console.debug("Could not determine account type", e);
  }

  origDate = getOrigDate(fullRawSource);

  // Detect charset from the message source
  const charset = detectCharset(fullRawSource);
  document.getElementById("charsetDisplay").textContent = charset;

  // Apply character limit
  charLimit = await getPref("fullsource_maxchars");
  let text;
  let percent;
  if (charLimit > -1 && fullRawSource.length > charLimit) {
    text = fullRawSource.substring(0, charLimit);
    percent = parseInt((charLimit / fullRawSource.length) * 100);
    document.getElementById("btn_showFull").classList.remove("hidden");
  } else {
    text = fullRawSource;
    percent = 100;
    charLimit = -1;
  }

  const percentStr = messenger.i18n
    .getMessage("percent")
    .replace("\u00A7", percent);
  document.getElementById("sourcePercent").textContent = percentStr;

  // Delay setting the textarea value slightly for large messages
  setTimeout(function () {
    document.getElementById("editFSarea").value = text;
    document.getElementById("editFSarea").setSelectionRange(0, 0);
    document.getElementById("editFSarea").focus();
  }, 100);
}

function detectCharset(raw) {
  const match = raw.match(/charset=["']?([^\s;"']+)/i);
  return match ? match[1].replace(/["']/g, "") : "UTF-8";
}

function showFullSource() {
  if (confirm(messenger.i18n.getMessage("fsBigMessage"))) {
    document.getElementById("editFSarea").value = fullRawSource;
    charLimit = -1;
    document.getElementById("btn_showFull").classList.add("hidden");
    const percentStr = messenger.i18n
      .getMessage("percent")
      .replace("\u00A7", "100");
    document.getElementById("sourcePercent").textContent = percentStr;
  }
}

async function save() {
  setBusy(true);
  try {
    const editedText = document.getElementById("editFSarea").value;

    // If we only loaded a partial source, append the unedited remainder
    let data;
    if (charLimit > -1) data = editedText + fullRawSource.substring(charLimit);
    else data = editedText;

    data = cleanCRLF(data);

    // Remove automatically generated X-Mozilla headers, to avoid duplicates
    data = data.replace(/X-Mozilla-.+\r\n/g, "");

    // Append CRLF to the last line if missing, to avoid it being deleted
    let lastChar = data.slice(-2);
    if (lastChar!="\r\n") data = data + "\r\n";

    if (await getPref("add_htl_header"))
      data = addHTLHeader(data, "bodyChanged");

    if (isImap && (await getPref("use_imap_fix")))
      data = applyImapFix(data, origDate);

    const newFile = new File([data], crypto.randomUUID() + ".eml", {
      type: "message/rfc822",
    });
    const result = await replaceMessage(messageId, newFile);
    setBusy(false);
    if (result) {
      try {
        await messenger.mailTabs.setSelectedMessages(tabId, [result.id]);
      } catch (e) {
        console.debug("Could not select updated message", e);
      }
      showStatus("ok");
      // Update internal state before closing
      messageId = result.id;
      const newRawFile = await getRawFile(messageId);
      fullRawSource = await newRawFile.text();
      origDate = getOrigDate(fullRawSource);
      document.getElementById("editFSarea").value = fullRawSource;
      charLimit = -1;
      document.getElementById("btn_showFull").classList.add("hidden");
      window.close();
    } else {
      showStatus("err");
    }
  } catch (e) {
    console.error("Header Tools Improved - save error:", e);
    setBusy(false);
    showStatus("err");
  }
}

function setBusy(busy) {
  document.getElementById("btn_save").disabled = busy;
  document.getElementById("btn_cancel").disabled = busy;
  document.getElementById("busy-spinner").classList.toggle("active", busy);
  document.getElementById("status-ok").classList.add("hidden");
  document.getElementById("status-err").classList.add("hidden");
}

async function showStatus(type) {
  const el = document.getElementById(type == "ok" ? "status-ok" : "status-err");
  el.classList.remove("hidden");
  await new Promise((r) => setTimeout(r, 3000));
  el.classList.add("hidden");
}

window.addEventListener("load", init);

window.addEventListener("beforeunload", (event) => {
  if (document.getElementById("btn_save").disabled) event.preventDefault();
});
