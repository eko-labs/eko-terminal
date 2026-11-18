import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import WhitepaperPage from "./docs/WhitepaperPage";
import "./index.css";

createRoot(document.getElementById("root")!).render(<StrictMode><WhitepaperPage /></StrictMode>);
