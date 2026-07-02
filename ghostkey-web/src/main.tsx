import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { LangProvider } from "./vocab";
// Self-hosted variable fonts — single woff2 per family covering all
// weights. Replaces the Google Fonts stylesheet so no third-party
// origin is needed in the CSP.
import "@fontsource-variable/inter";
import "@fontsource-variable/inter-tight";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <LangProvider>
        <App />
      </LangProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
