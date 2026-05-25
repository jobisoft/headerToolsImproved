import { getPref } from "../options/defaults.mjs";
import { localizeDocument } from "../vendor/i18n.mjs";
import {
  cleanCRLF,
  encodeHeader,
  addHTLHeader,
  applyImapFix,
  getOrigDate,
  getRawFile,
  replaceMessage,
} from "./messageOps.mjs";

let messageId;
let tabId;
let rawFile;
let rawText;
let origDate;
let origInReplyTo;
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

  rawFile = await getRawFile(messageId);
  rawText = await rawFile.text();
  const full = await messenger.messages.getFull(messageId);
  const hdr = await messenger.messages.get(messageId);
  const h = full.headers;

  try {
    const account = await messenger.accounts.get(hdr.folder?.accountId, false);
    isImap = account?.type === "imap";
  } catch (e) {
    console.debug("Could not determine account type", e);
  }

  origDate = getOrigDate(rawText);

  // Populate form fields
  document.getElementById("subBox").value = h.subject?.[0] || "";

  // Split day-of-week prefix from the rest of the date
  const dateVal = origDate;
  const dayMatch = dateVal.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s*,\s*(.*)/);
  if (dayMatch) {
    document.getElementById("date3").value = dayMatch[1];
    document.getElementById("dateBox").value = dayMatch[2];
  } else {
    document.getElementById("dateBox").value = dateVal;
  }

  document.getElementById("authBox").value = h.from?.[0] || "";
  document.getElementById("recBox").value = h.to?.[0] || "";
  document.getElementById("replytoBox").value = h["reply-to"]?.[0] || "";
  document.getElementById("midBox").value = h["message-id"]?.[0] || "";

  origInReplyTo = h["in-reply-to"]?.[0] || "";
  document.getElementById("inreplytoBox").value = origInReplyTo;
  document.getElementById("refBox").value = h.references?.[0] || "";
}

async function save() {
  setBusy(true);
  try {
    const day = document.getElementById("date3").value;
    const dateRest = document.getElementById("dateBox").value;
    const newDate = day ? day + ", " + dateRest : dateRest;

    const newSubject = document.getElementById("subBox").value;
    const newAuthor = document.getElementById("authBox").value;
    const newRecipients = document.getElementById("recBox").value;
    const newReplyTo = document.getElementById("replytoBox").value;
    const newMid = document.getElementById("midBox").value;
    const newInReplyTo = document.getElementById("inreplytoBox").value;
    let newRef = document.getElementById("refBox").value;

    // If In-Reply-To changed, copy it to References
    if (newInReplyTo !== origInReplyTo) newRef = newInReplyTo;

    // MIME-encode header values via the messengerUtilities API
    let newSubEnc = await encodeHeader("Subject", newSubject);
    let newAuthEnc = await encodeHeader("From", newAuthor);
    const newRecEnc = await encodeHeader("To", newRecipients);
    const newReplyToEnc = await encodeHeader("Reply-To", newReplyTo);

    const endHeaders = rawText.search(/\r\n\r\n/);
    let headers = rawText.substring(0, endHeaders);
    headers = cleanCRLF(headers);

    // Unfold multi-line headers if necessary
    for (let name of ["Subject", "From", "To", "Reply-To"]) {
      const re = new RegExp(`(\r\n${name}: .*)(\r\n\\s+)`, "i");
      while (re.test(headers)) headers = headers.replace(re, "$1 ");
    }

    // This will be removed after the replacements, it makes it easier to test headers
    headers = "\n" + headers + "\r\n";

    // Fix missing <brackets> for RSS authors
    if (headers.indexOf("\nContent-Base:") > -1)
      newAuthEnc = "<" + newAuthEnc + ">";

    // Replace each header, handling case variations and missing headers
    headers = replaceHeader(headers, "Subject", newSubEnc);
    headers = replaceHeader(headers, "Date", newDate);
    headers = replaceHeader(headers, "From", newAuthEnc);
    headers = replaceHeader(headers, "To", newRecEnc);
    headers = replaceHeader(headers, "Reply-To", newReplyToEnc);
    headers = replaceMessageId(headers, newMid);
    headers = replaceHeader(headers, "In-Reply-To", newInReplyTo);
    headers = replaceHeader(headers, "References", newRef);

    // Remove automatically generated X-Mozilla headers, to have fewer duplicates
    headers = headers.replace(/X-Mozilla-.+\r\n/g, "");

    if (newRef === "")
      // references removed
      headers = headers.replace(
        /\nIn-Reply-To: *.*\r\n/,
        "\nIn-Reply-To: \r\n",
      );

    // Strip off characters added before the replacements
    headers = headers.substring(1, headers.length - 2);

    if (await getPref("add_htl_header"))
      headers = addHTLHeader(headers + "\r\n\r\n", "headerChanged").slice(
        0,
        -4,
      );

    if (isImap && (await getPref("use_imap_fix")))
      headers = applyImapFix(headers, origDate);

    // Build the new message: modified headers (ASCII) + original body bytes.
    // Since RFC2822 headers are 7-bit ASCII, the byte offset in the raw file
    // matches the character offset from .text().
    const bodyBlob = rawFile.slice(endHeaders);
    const newFile = new File(
      [headers, bodyBlob],
      crypto.randomUUID() + ".eml",
      { type: "message/rfc822" },
    );

    const result = await replaceMessage(messageId, newFile);
    setBusy(false);
    if (result) {
      try {
        await messenger.mailTabs.setSelectedMessages(tabId, [result.id]);
      } catch (e) {
        console.debug("Could not select updated message", e);
      }
      showStatus("ok");
      // Update internal state so the user can save again
      messageId = result.id;
      rawFile = await getRawFile(messageId);
      rawText = await rawFile.text();
      origDate = getOrigDate(rawText);
      const full = await messenger.messages.getFull(messageId);
      origInReplyTo = full.headers?.["in-reply-to"]?.[0] || "";
    } else {
      showStatus("err");
    }
  } catch (e) {
    console.error("Header Tools Improved - save error:", e);
    setBusy(false);
    showStatus("err");
  }
}

function replaceHeader(headers, name, value) {
  const lowerName = name.toLowerCase();
  if (headers.indexOf("\n" + name + ":") > -1)
    return headers.replace(
      new RegExp("\n" + name + ": *.*\r\n"),
      "\n" + name + ": " + value + "\r\n",
    );
  if (headers.indexOf("\n" + lowerName + ":") > -1)
    return headers.replace(
      new RegExp("\n" + lowerName + ": *.*\r\n"),
      "\n" + lowerName + ": " + value + "\r\n",
    );
  // header missing, append it
  return headers + name + ": " + value + "\r\n";
}

function replaceMessageId(headers, newMid) {
  for (let variant of ["Message-ID", "Message-Id", "Message-id"]) {
    if (headers.indexOf("\n" + variant + ":") > -1) {
      // fix newline-only values
      headers = headers.replace(
        new RegExp("\n" + variant + ":\r\n"),
        "\n" + variant + ":",
      );
      headers = headers.replace(
        new RegExp("\n" + variant + ": *.*\r\n"),
        "\n" + variant + ": " + newMid + "\r\n",
      );
      return headers;
    }
  }
  if (newMid) {
    const formatted =
      newMid.substring(0, 1) == "<" ? newMid : "<" + newMid + ">";
    return headers + "Message-ID: " + formatted + "\r\n";
  }
  return headers;
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
