const cors = require("cors");

module.exports = cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  // Cross-origin fetch() hides every response header except a small
  // "simple" set by default. The Data Export page's download buttons now
  // read the real filename off Content-Disposition via fetch() (instead
  // of a raw <a href> navigation, which had no way to detect a failed
  // request before the browser committed to it — see DataExportPage.js's
  // triggerBlobDownload for the full story) — this is what makes that
  // header visible to the frontend's JS at all.
  exposedHeaders: ["Content-Disposition"],
});