import express from "express";
import cors from "cors";
import p3dxRoutes from "./routes/p3dx.routes.js";
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
      "http://localhost:5175",
      "https://login.p3dx.iudx.org.in",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: ['text/*', 'application/jwt'] }));

app.use("/anon", p3dxRoutes);
app.use("/p3dx", p3dxRoutes);

app.use(errorMiddleware);

export default app;
