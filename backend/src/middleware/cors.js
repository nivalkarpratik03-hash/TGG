const cors = require("cors");

// Allowed browser origins, comma-separated. Example:
//   CORS_ORIGINS=https://app.example.com,https://admin.example.com
// Same-origin requests (the Express server serving the React build) never need CORS.
// In development (NODE_ENV != production) localhost origins are allowed automatically.
const IS_PROD = process.env.NODE_ENV === "production";
const list = (process.env.CORS_ORIGINS || process.env.PUBLIC_FRONTEND_ORIGIN || "")
  .split(",").map((s) => s.trim().replace(/\/$/, "")).filter(Boolean);

function isAllowed(origin) {
  if (!origin) return true;                       // curl, health checks, same-origin GETs
  const o = origin.replace(/\/$/, "");
  if (list.includes(o)) return true;
  if (!IS_PROD && /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(o)) return true;
  return false;
}

const corsMiddleware = cors({
  origin: (origin, cb) => cb(null, isAllowed(origin)),
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Admin-Token"],
  // Lets the Data Export page read the real filename off Content-Disposition.
  exposedHeaders: ["Content-Disposition"],
  maxAge: 600,
});

module.exports = corsMiddleware;
module.exports.isAllowed = isAllowed;