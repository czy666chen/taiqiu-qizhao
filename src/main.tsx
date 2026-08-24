import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import GameApp from "../app/GameApp";
import "../app/globals.css";
import "../app/admin.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("无法找到应用挂载节点");
}

createRoot(root).render(
  <StrictMode>
    <GameApp />
  </StrictMode>,
);
