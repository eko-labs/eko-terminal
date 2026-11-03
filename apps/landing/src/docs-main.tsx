import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MotionConfig } from "framer-motion";
import DocsPage from "./docs/DocsPage";
import "./index.css";

createRoot(document.getElementById("root")!).render(<StrictMode><MotionConfig reducedMotion="user"><DocsPage /></MotionConfig></StrictMode>);
