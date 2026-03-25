# Agent Management Service

The **Agent Service** is the core orchestration service for the AgenticAI platform, managing the definition, state, and execution of autonomous AI agents.

---

## 🚀 Key Features

- **Agent Registry**: Manage agent configurations including system prompts, model parameters, and allowed tools.
- **Workflow Orchestration**: Uses **Temporal** to manage stateful, fault-tolerant agent conversations and reasoning loops.
- **Tool Integration**: Seamlessly communicates with the `tools-service` to provide agents with real-world capabilities.
- **User Delegation**: Securely executes agents on behalf of authenticated users, maintaining strict data isolation.
- **High Reliability**: Leveraging Temporal for automatic retries, timeouts, and persistent progress tracking of agent tasks.

---

## 🛠 Technology Stack

- **Framework**: Express
- **Orchestration**: Temporal SDK (`@temporalio`)
- **Database**: PostgreSQL (`pg`)
- **Tracing & Logging**: Pino
- **Language**: TypeScript

---

## 📥 Getting Started

### Prerequisites

- Node.js (v18 or higher)
- PostgreSQL
- Temporal server (running locally or via Cloud)
- Access to the `tools-service`

### Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Configure environment variables in a `.env` file.

### Development

Run the API server:
```bash
npm run dev
```

Run the Temporal worker:
```bash
npm run worker
```

---

## 🏗 Architecture

- **`src/index.ts`**: Entry point for API requests.
- **`src/temporal/`**: Core Temporal workflows and activities for agent execution.
- **`src/services/`**: logic for agent creation and configuration management.
- **`src/controllers/`**: API handlers.
- **`src/routes/`**: Route definitions.
- **`src/models/`**: PostgreSQL interaction layer.

---

## 🔗 Integration

This service coordinates closely with:
- **`auth-user-service`**: For managing user context and authentication.
- **`tools-service`**: To provide agents with specialized capabilities (KBs, KGs, MCPs).
- **`storage-service`**: If agents need to store or retrieve large files/objects.
