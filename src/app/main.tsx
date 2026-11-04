import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { applyTheme, readTheme } from "./client/browser.ts"
import "./shell.css"

const root = document.getElementById("root")
if (root === null) throw new Error("Application root is missing")
const theme = readTheme()
const themeSaved = applyTheme(theme)

createRoot(root).render(
  <StrictMode>
    <App initialTheme={theme} initialThemeSaved={themeSaved} />
  </StrictMode>,
)
