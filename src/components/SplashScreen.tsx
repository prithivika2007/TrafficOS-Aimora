import { motion } from "framer-motion";

interface SplashScreenProps {
  onInitialize: () => void;
}

export default function SplashScreen({ onInitialize }: SplashScreenProps): React.JSX.Element {
  return (
    <motion.main
      className="splash-screen bg-slate-950"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.02 }}
      transition={{ duration: 0.45, ease: "easeInOut" }}
    >
      <div className="splash-grid" aria-hidden="true" />
      <motion.section
        className="splash-card"
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.55, delay: 0.12, ease: "easeOut" }}
        aria-labelledby="splash-title"
      >
        <div className="signal-mark" role="img" aria-label="Animated red, amber, and green traffic signal">
          <span className="signal-lamp signal-lamp-red" />
          <span className="signal-lamp signal-lamp-amber" />
          <span className="signal-lamp signal-lamp-green" />
        </div>
        <div className="splash-status"><span /> SYSTEM READY · TRAFFIC KERNEL</div>
        <h1 id="splash-title">Traffic<span>OS</span></h1>
        <p className="splash-subtitle">AI-Driven Intelligent Traffic Kernel &amp; Real-Time Safety Guardian</p>
        <button className="splash-initialize" type="button" onClick={onInitialize}>
          Initialize TrafficOS Kernel <span aria-hidden="true">→</span>
        </button>
        <p className="splash-footnote">SMART MOBILITY · SAFETY-FIRST · REAL-TIME</p>
      </motion.section>
    </motion.main>
  );
}
