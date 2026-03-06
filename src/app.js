import express from "express";
import cors from "cors";
import anonRoutes from "./routes/anon.routes.js";
import errorMiddleware from "./middlewares/error.middleware.js";

const app = express();

const corsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

/**
 * CORS middleware
 * This automatically handles preflight (OPTIONS) correctly
 */
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (corsOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS: origin not allowed"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: ['text/*', 'application/jwt'] }));

app.use("/anon", anonRoutes);

app.use(errorMiddleware);

export default app;
