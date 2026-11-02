# 🚦 TrafficOS – Intelligent Traffic Signal Control System

**An Operating System-Based Approach to Smarter Traffic Management**

TrafficOS is an intelligent traffic signal management system that applies Operating System CPU scheduling algorithms to optimize traffic flow at road intersections. It aims to reduce vehicle waiting time, improve traffic throughput, prioritize emergency vehicles, and enhance intersection safety through intelligent signal allocation.

## 🌟 Overview

Traditional traffic signals often operate using fixed-time intervals, which do not adapt effectively to changing traffic density. This can result in long queues, unnecessary waiting times, and delays for emergency vehicles.

TrafficOS addresses these challenges by applying CPU scheduling concepts to traffic signal management, treating vehicles and traffic lanes as scheduling entities.

The system provides an interactive traffic simulation environment where users can observe traffic conditions, experiment with signal allocation, and compare scheduling algorithms.

## ✨ Key Features

### 1. Intelligent Traffic Scheduling
- Implements **Round Robin Scheduling** for fair signal allocation.
- Uses **Priority Scheduling with Aging** to prioritize important traffic while preventing starvation.
- Allocates green signal time based on traffic conditions and scheduling logic.

### 2. Emergency Vehicle Prioritization
- Prioritizes emergency vehicles such as ambulances.
- Supports emergency clearance through priority-based signal allocation.
- Coordinates emergency clearance with the safety layer.

### 3. Traffic Safety Layer
- Detects simulated red-light violations.
- Implements controlled all-red signal extensions.
- Prevents conflicting green signals during safety holds.
- Maintains structured violation logs and safety status information.

### 4. Interactive Traffic Simulation
- Simulates traffic movement across North, South, East, and West directions.
- Allows users to experiment with traffic conditions.
- Displays signal phases, vehicle queues, and traffic movement.
- Supports simulation controls.

### 5. Algorithm Comparison
Compare traffic scheduling strategies using performance indicators such as:
- Average Waiting Time
- Traffic Throughput
- Maximum Waiting Time
- Average and Maximum Queue Length
- Signal Phase Transitions

## 🧠 Algorithms Used

| Algorithm | Application |
|---|---|
| Round Robin (RR) | Fair allocation of green signal time |
| Priority Scheduling | Prioritizing important traffic |
| Aging | Preventing starvation of waiting lanes |
| Fixed-Time Scheduling | Baseline comparison (where implemented) |

## 🏗️ Technology Stack

- **Frontend:** React, TypeScript
- **Build Tool:** Vite
- **Styling:** CSS, Tailwind CSS
- **Simulation Logic:** TypeScript
- **Version Control:** Git & GitHub
- **Deployment:** Vercel

## ⚙️ Installation and Setup

### Prerequisites
- Node.js
- npm
- Git

### 1. Clone the Repository

```bash
git clone https://github.com/prithivika2007/TrafficOS-Aimora.git
```

### 2. Navigate to the Project Directory

```bash
cd TrafficOS-Aimora
```

### 3. Install Dependencies

```bash
npm install
```

### 4. Run the Development Server

```bash
npm run dev
```

### 5. Build for Production

```bash
npm run build
```

## 📊 Project Objectives

- Reduce unnecessary vehicle waiting time.
- Improve traffic signal allocation efficiency.
- Provide priority passage for emergency vehicles.
- Minimize traffic conflicts through safety mechanisms.
- Demonstrate how Operating System scheduling algorithms can solve real-world problems.

## 🔮 Future Enhancements

- Real-time CCTV integration for vehicle detection.
- Machine Learning-based traffic density prediction.
- IoT-enabled smart traffic signal controllers.
- GPS-based emergency vehicle tracking.
- Integration with real-world traffic monitoring systems.

## 🎯 Project Significance

TrafficOS demonstrates how concepts traditionally used in Operating Systems can be extended beyond computing environments to address real-world urban challenges.

By combining scheduling algorithms, traffic simulation, emergency prioritization, and safety mechanisms, TrafficOS explores a practical approach toward intelligent and adaptive traffic management.

