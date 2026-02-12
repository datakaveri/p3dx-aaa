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
    origin: "http://localhost:5173",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

app.use("/anon", anonRoutes);

app.use(errorMiddleware);

export default app;
