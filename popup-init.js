// Ensure pdfjs worker points to extension resource
if (typeof pdfjsLib !== "undefined") {
  // use chrome.runtime.getURL so worker path is correct in extension
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendors/pdf.worker.min.js");
}