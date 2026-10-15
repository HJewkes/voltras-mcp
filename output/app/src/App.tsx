import { useEffect, useState } from "react";
import current from "../../../fixtures/1-current.json";
import full from "../../../fixtures/2-full-session.json";
import edges from "../../../fixtures/3-edges.json";
import type { SessionSummary, Units } from "./types";
import { SessionPage } from "./components/SessionPage";

const FIXTURES: Record<string, SessionSummary> = {
  "1": current as SessionSummary,
  "2": full as SessionSummary,
  "3": edges as SessionSummary,
};

const params = new URLSearchParams(window.location.search);

export function App() {
  const summary = FIXTURES[params.get("f") ?? "2"] ?? FIXTURES["2"];
  const [units, setUnits] = useState<Units>(params.get("units") === "kg" ? "kg" : "lb");
  useEffect(() => {
    document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark";
  }, []);
  return (
    <div className="shell">
      <div className="chrome chrome--rail" aria-hidden>rail</div>
      <div className="chrome chrome--top" aria-hidden>status bar</div>
      <SessionPage summary={summary} units={units} onUnits={setUnits} />
      <div className="chrome chrome--phone" aria-hidden>nav</div>
    </div>
  );
}
