import Hero from "./sections/Hero";
import CTA from "./sections/CTA";
import { MotionConfig } from "framer-motion";
import { Footer } from "./sections/EkoSections";
import FlightRecorder from "./sections/FlightRecorder";
import Roadmap from "./sections/Roadmap";
import { Senses, Harness, LoopLab } from "./sections/ProductScenes";
import SignalGrid from "./sections/SignalGrid";
import EkoBento from "./sections/EkoBento";
import IntroGate from "./IntroGate";
import FAQ from "./sections/FAQ";
import "./eko.css";

function Landing() {
  return (
    <div className="eko-marketing" id="top">
      <a className="skip-link" href="#senses">
        Skip to signal discovery
      </a>
      <main>
        <Hero />
        <p className="dashboard-caption">
          EKO Radar · Sample snapshot{" "}
          <a href="/radar">Explore EKO's terminal ↗</a>
        </p>
        <SignalGrid />
        <Senses />
        <Harness />
        <LoopLab />
        <FlightRecorder />
        <Roadmap />
        <div id="mission-control">
          <EkoBento />
        </div>
        <FAQ />
        <div id="explore" className="eko-closing">
          <CTA />
          <p className="dashboard-caption">EKO Radar · Sample snapshot</p>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function App() {
  return (
    <MotionConfig reducedMotion="user">
      <IntroGate>
        <Landing />
      </IntroGate>
    </MotionConfig>
  );
}

export default App;
