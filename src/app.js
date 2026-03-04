import express from "express";
import cors from "cors";
import anonRoutes from "./routes/anon.routes.js";
import errorMiddleware from "./middlewares/error.middleware.js";

const app = express();

/**
 * CORS middleware
 * This automatically handles preflight (OPTIONS) correctly
 */
app.use(
  cors({
    origin: [
      "https://spider.p3dx.iudx.org.in",
      "http://localhost:5173",
      "http://localhost:5174",
      "https://login.p3dx.iudx.org.in",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: ['text/*', 'application/jwt'] }));

app.use("/anon", anonRoutes);

app.use(errorMiddleware);

export default app;
