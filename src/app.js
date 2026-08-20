import express from "express";
import cors from "cors";
import p3dxRoutes from "./routes/p3dx.routes.js";
import formSubmissionsRoutes from "./routes/formSubmissions.routes.js";
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
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: ['text/*', 'application/jwt'] }));

app.use("/anon", p3dxRoutes);
app.use("/p3dx", p3dxRoutes);
app.use("/anon", formSubmissionsRoutes);
app.use("/p3dx", formSubmissionsRoutes);

app.use(errorMiddleware);

export default app;
