import React, { useState, useEffect, useRef, useCallback } from "react";
import TrafficOSSimulator from "./TrafficOSSimulator";
import LiveTrafficConsole from "./components/LiveTrafficConsole";
import QueueAnalytics from "./components/QueueAnalytics";
import { createSim, defaultSetup } from "./simEngine";
import type { Sim } from "./simEngine";

type TabId = "landing" | "simulator" | "console" | "analytics" | "logs";

interface NavTab {
  id: TabId;
  label: string;
  icon: string;
}

export default function App(): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>("landing");
  const [time, setTime] = useState<string>(new Date().toLocaleTimeString());
  const [cpuUsage, setCpuUsage] = useState<number>(14);
  const [simulationRevision, setSimulationRevision] = useState(0);
  const simulationRef = useRef<Sim>(createSim(defaultSetup(), "RR"));
  const notifySimulationUpdate = useCallback(
    () => setSimulationRevision((revision) => revision + 1),
    []
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date().toLocaleTimeString());
      setCpuUsage(Math.floor(12 + Math.random() * 8));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const navTabs: NavTab[] = [
    { id: "landing", label: "Overview", icon: "✨" },
    { id: "simulator", label: "Kernel Simulator", icon: "⚙️" },
    { id: "console", label: "Live CCTV Feed", icon: "👁️" },
    { id: "analytics", label: "Queue Analytics", icon: "📊" },
    { id: "logs", label: "Kernel Logs", icon: "📋" },
  ];

  return (
    <div className="min-h-screen bg-[#090b10] text-slate-100 font-sans antialiased flex flex-col selection:bg-amber-400 selection:text-slate-950">
      {/* 1. TOP OS STATUS BAR */}
      <header className="h-9 bg-[#0d1017] border-b border-slate-800/80 px-4 flex items-center justify-between text-xs text-slate-400 font-mono select-none">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-2 font-bold text-amber-300 tracking-wider">
            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-sm shadow-amber-400" />
            TRAFFIC_OS v2.4-KERNEL
          </span>
          <span className="hidden md:inline-block text-slate-700">|</span>
          <span className="hidden md:flex items-center gap-1.5">
            <span className="text-slate-500">CPU:</span>
            <span className="text-emerald-400 font-bold">{cpuUsage}%</span>
          </span>
          <span className="hidden md:inline-block text-slate-700">|</span>
          <span className="hidden md:flex items-center gap-1.5">
            <span className="text-slate-500">SCHEDULER:</span>
            <span className="text-amber-200/90 font-semibold">ROUND_ROBIN_W_AGING</span>
          </span>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300 font-bold text-[10px] tracking-wider uppercase">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            <span>SYSTEM ACTIVE</span>
          </div>
          <span className="text-slate-300 font-bold">{time}</span>
        </div>
      </header>

      {/* 2. MAIN NAVIGATION BAR */}
      <nav className="sticky top-0 z-50 bg-[#0d1017]/95 backdrop-blur-xl border-b border-slate-800/80 px-4 sm:px-6 py-3 flex items-center justify-between gap-4 shadow-2xl">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-amber-400 via-yellow-500 to-amber-200 p-[1px] shadow-lg shadow-amber-500/10">
            <div className="w-full h-full bg-[#090b10] rounded-[11px] flex items-center justify-center font-black text-amber-300 tracking-tighter text-sm">
              TOS
            </div>
          </div>
          <div>
            <h1 className="font-extrabold text-sm tracking-wide text-white flex items-center gap-2">
              TrafficOS <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-400/10 text-amber-300 border border-amber-400/30 font-bold">Pro Console</span>
            </h1>
          </div>
        </div>

        {/* LUXURY HIGH-CONTRAST TAB BUTTONS */}
        <div className="flex bg-[#05070a] border border-slate-800 p-1.5 rounded-2xl gap-1">
          {navTabs.map((tab) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3.5 py-2 rounded-xl font-bold text-xs sm:text-xs transition-all duration-200 flex items-center gap-2 tracking-wide ${
                  isActive
                    ? "bg-gradient-to-r from-amber-400 via-amber-300 to-yellow-500 text-slate-950 shadow-md shadow-amber-500/20 font-black scale-[1.02]"
                    : "text-slate-400 hover:text-white hover:bg-slate-900/60"
                }`}
              >
                <span className="text-sm">{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* 3. CONSTRAINED MAIN CONTENT CONTAINER */}
      <main className="flex-1 p-4 md:p-6 max-w-7xl w-full mx-auto">
        <div className={activeTab === "simulator" ? "rounded-3xl border border-slate-800/80 bg-[#0d1017]/80 backdrop-blur-xl p-3 sm:p-6 shadow-2xl" : "hidden"}>
          <TrafficOSSimulator
            simulationRef={simulationRef}
            simulationRevision={simulationRevision}
          />
        </div>

        {activeTab === "console" && (
          <div className="rounded-3xl border border-slate-800/80 bg-[#0d1017]/80 backdrop-blur-xl p-4 sm:p-6 shadow-2xl">
            <LiveTrafficConsole
              simulationRef={simulationRef}
              onSimulationUpdate={notifySimulationUpdate}
            />
          </div>
        )}

        {activeTab === "landing" && (
          <div className="relative min-h-[70vh] flex flex-col items-center justify-center px-4 overflow-hidden font-mono text-slate-100">
            {/* Background Ambient Glow */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[550px] h-[300px] bg-gradient-to-tr from-amber-500/10 via-yellow-500/5 to-cyan-500/5 blur-[130px] rounded-full pointer-events-none" />

            {/* Main Luxury Glass Showcase */}
            <div className="relative z-10 max-w-3xl w-full p-8 md:p-12 rounded-3xl bg-[#0d1017]/90 backdrop-blur-2xl border border-slate-800 shadow-[0_0_60px_rgba(0,0,0,0.6)] text-center space-y-8">
              
              {/* Badge */}
              <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-300 text-[11px] font-semibold tracking-wider uppercase shadow-sm">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                AIML Department Expo Showcase • TrafficOS v2.4
              </div>

              {/* Title & Description */}
              <div className="space-y-4">
                <h2 className="text-3xl md:text-5xl font-black tracking-tight text-white leading-tight">
                  Simulating OS Scheduling via <span className="bg-gradient-to-r from-amber-300 via-yellow-200 to-amber-400 bg-clip-text text-transparent">Traffic Micro-Control</span>
                </h2>
                <p className="text-slate-400 text-xs md:text-sm max-w-xl mx-auto leading-relaxed">
                  Bridge theoretical CPU scheduling algorithms with visual intersection management. Experience zero-starvation round-robin workflows and instant emergency preemption.
                </p>
              </div>

              {/* 3 Pillars Grid */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-left">
                {[
                  { title: "Round Robin (RR)", desc: "Fair cyclical green-light quanta distribution." },
                  { title: "Dynamic Aging", desc: "Prevents process starvation over time." },
                  { title: "Ambulance AI", desc: "Instant preemption for emergency lanes." },
                ].map((item, idx) => (
                  <div key={idx} className="p-4 rounded-2xl bg-[#080a0f] border border-slate-800/80 shadow-inner hover:border-amber-500/30 transition-all">
                    <div className="text-xs font-bold text-amber-300 mb-1">0{idx + 1}. {item.title}</div>
                    <div className="text-[11px] text-slate-400 leading-normal">{item.desc}</div>
                  </div>
                ))}
              </div>

              {/* Launch Button */}
              <div className="pt-2">
                <button
                  onClick={() => setActiveTab("simulator")}
                  className="group relative inline-flex items-center gap-3 px-8 py-4 rounded-2xl bg-gradient-to-r from-amber-400 via-amber-300 to-yellow-500 text-slate-950 font-black text-xs tracking-widest uppercase shadow-[0_0_35px_rgba(245,158,11,0.25)] hover:shadow-[0_0_45px_rgba(245,158,11,0.4)] hover:scale-[1.02] active:scale-[0.98] transition-all duration-300"
                >
                  <span>Launch Kernel Simulator</span>
                  <span className="group-hover:translate-x-1 transition-transform">→</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "analytics" && (
          <div className="rounded-3xl border border-slate-800/80 bg-[#0d1017]/80 backdrop-blur-xl p-4 sm:p-6 shadow-2xl">
            <QueueAnalytics />
          </div>
        )}

        {activeTab === "logs" && (
          <div className="p-6 bg-[#080a0f] border border-slate-800/80 rounded-3xl font-mono text-xs text-slate-300 space-y-2.5 shadow-2xl">
            <div className="text-amber-300 font-bold border-b border-slate-800 pb-3 flex items-center justify-between">
              <span>[KERNEL LOG SYSTEM — LIVE TRACE]</span>
              <span className="text-[10px] text-slate-500">BUFFER SIZE: 4.2 KB</span>
            </div>
            <div className="text-slate-400">[08:42:01] INFO: Initialized Intersection Node #01 [SRM_AIML_CLUSTER]</div>
            <div className="text-cyan-300">[08:42:02] KERNEL: Active Algorithm set to Round-Robin (Time Quantum: 3s)</div>
            <div className="text-emerald-300">[08:42:05] SCHEDULER: Switched priority signal to NORTH lane (Weight: 1.0)</div>
            <div className="text-amber-350">[08:42:08] AGING_ENGINE: Evaluated starvation weights. Delta waiting threshold normal.</div>
          </div>
        )}
      </main>
    </div>
  );
}