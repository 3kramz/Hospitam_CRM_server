# Hospital CRM Server

![Node.js](https://img.shields.io/badge/Node.js-v14%2B-green)
![Express](https://img.shields.io/badge/Express-v4.17%2B-blue)
![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-green)
![License](https://img.shields.io/badge/License-Non--Commercial-red)

The **Hospital CRM Server** is a robust, scalable backend application designed to manage the core operations of a modern hospital diagnostic center. It provides a secure API for patient registration, complex billing and invoicing, laboratory workflow automation, and role-based user management.

Built with **Node.js** and **Express**, and backed by **MongoDB**, this server ensures real-time data consistency and secure access control via JWT.

---

## 📑 Table of Contents

- [Key Features](#-key-features)
- [Tech Stack & Architecture](#-tech-stack--architecture)
- [Prerequisites](#-prerequisites)
- [Installation & Setup](#-installation--setup)
- [Configuration (.env)](#-configuration)
- [Database Schema](#-database-schema)
- [API Documentation](#-api-documentation)
- [Deployment](#-deployment)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🚀 Key Features

*   **Secure Authentication**: JWT (JSON Web Token) based authentication with role-based authorization middlewares (`verifyAdmin`, `verifyLabExpert`, etc.).
*   **Patient Database**: Centralized hub for storing patient demographics, medical history (invoicing), and contact details.
*   **Dynamic Invoicing**: 
    *   Generates unique invoice IDs.
    *   Calculates totals, discounts, and due amounts dynamically.
    *   Supports partial payments and payment status tracking (`PAID`, `DUE`).
*   **Lab Workflow Automation**:
    *   **Status Tracking**: Monitors tests from `Assigned` to `Delivered`.
    *   **Lab Queue**: dedicated endpoint for lab technicians to view pending samples.
    *   **Bulk Updates**: Ability to update the status of an entire report/invoice at once.
*   **Dashboard Analytics**: Aggregation pipeline powered statistics for daily revenue, test counts, and financial summaries.
*   **CORS Enabled**: Configured for seamless cross-origin resource sharing with frontend clients.

---

## 🏗 Tech Stack & Architecture

The application follows a **Route-Controller (Implicit)** pattern.

*   **Runtime**: [Node.js](https://nodejs.org/)
*   **Framework**: [Express.js](https://expressjs.com/)
*   **Database**: [MongoDB](https://www.mongodb.com/) (NoSQL)
*   **Authentication**: `jsonwebtoken` (JWT)
*   **Deployment config**: Vercel Serverless Functions (`vercel.json`)

**Folder Structure:**
```
├── config/           # Database connection logic
├── jwt/              # Security middlewares (verifyToken, verifyAdmin, etc.)
├── routes/           # API Endpoints
│   ├── doctors/      # Doctor management
│   ├── patients/     # Patient CRUD operations
│   ├── tests/        # Core logic: Billing, Reports, Lab Board
│   ├── users.js      # User/Staff management
│   └── base.js       # Health check
├── utils/            # Helper functions (ID generation)
├── index.js          # Application entry point & Server config
└── vercel.json       # Deployment configuration for Vercel
```

---

## 📋 Prerequisites

Ensure you have the following installed on your local machine:

*   **Node.js**: Version 14.x or higher.
*   **npm**: Version 6.x or higher.
*   **MongoDB Cluster**: A hosted MongoDB Atlas cluster or local instance.

---

## ⚡ Installation & Setup

1.  **Clone the Repository**
    ```bash
    git clone https://github.com/3kramz/Hospitam_CRM_server.git
    cd Hospitam_CRM_server
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Environment Configuration**
    Create a `.env` file in the root directory. Copy the keys from `.env.example`:
    ```bash
    cp .env.example .env
    ```

4.  **Update Database Connection (Critical)**
    The project currently has a hardcoded connection string pattern in `config/db.js`.
    
    *   **Option A (Recommended)**: Edit `config/db.js` to use the `DB_USER` and `DB_PASS` from your `.env` file properly, or paste your *entire* connection string there.
    *   **Option B**: Ensure your `.env` variables match the hardcoded format: `mongodb+srv://<DB_USER>:<DB_PASS>@<CLUSTER_URL>/...`

5.  **Run Locally**
    ```bash
    # using nodemon for hot-reloading
    npm run start/nodemon 
    
    # OR standard node
    node index.js
    ```
    Server will start at `http://localhost:5000`.

---

## 🔧 Configuration

The `.env` file must contain the following variables:

| Variable | Description | Example |
| :--- | :--- | :--- |
| `DB_USER` | MongoDB Username | `admin` |
| `DB_PASS` | MongoDB Password | `password123` |
| `PORT` | Server Port | `5000` |
| `ACCESS_TOKEN` | Secret key for signing JWTs | `a1b2c3d4...` |

---

## 🗄 Database Schema

The application primarily uses the following collections:

1.  **`users`**: Stores staff credentials and roles.
    *   *Fields*: `email`, `name`, `role` (or `roles`), `department` (or `departments`).
2.  **`patients`**: Stores unique patient entities.
    *   *Fields*: `pid` (Patient ID), `name`, `age`, `phone`, `testGroupIds` (Array of linked invoices).
3.  **`testGroups`** (Invoices): The core transactional document.
    *   *Fields*: `invoiceId`, `patientId`, `tests` (Array of test objects), `grandTotal`, `payment`, `createdAt`.
    *   *Test Object*: `{ test_id, name, price, status, roomNumber, ... }`
4.  **`tests`** (Master List): Catalog of available tests and prices.
    *   *Fields*: `name`, `price`, `department`.

---

## 📡 API Documentation

### Authentication
All protected routes require a **Bearer Token** in the authorization header (managed via `axios` interceptors on the client).

### 1. User Management (`/users`)
*   **GET** `/users` - List all users *(Admin only)*.
*   **POST** `/users` - Create a new user *(Admin only)*.
    *   *Body*: `{ "name": "John", "email": "lab@gmail.com", "role": "lab_expert" }`
*   **PATCH** `/users/role` - Modify user permissions *(Admin only)*.

### 2. Patient & Billing (`/tests`)

#### Create Invoice
*   **POST** `/tests/save-patient-bill`
*   **Description**: Creates a new patient (if not exists) and generates an invoice.
*   **Body**:
    ```json
    {
      "patientInfo": { "name": "Doe", "age": 30, "phone": "1234567890" },
      "tests": [
        { "test_id": "101", "name": "CBS", "price": 500, "department": "Pathology" }
      ],
      "payment": 200,
      "grandTotal": 500
    }
    ```

#### Mobile/Lab Report Queue
*   **GET** `/tests/lab-queue`
*   **Query Params**: `?status=assigned,test_running`
*   **Description**: Used by Lab Experts to see worklists.

#### Status Updates
*   **PATCH** `/tests/status`
*   **Description**: Update a single test's status.
*   **Body**: `{ "groupId": "...", "testId": "...", "status": "sample_collected" }`

#### Reports & History
*   **GET** `/tests/all-reports`
*   **Query Params**: `?page=1&limit=10&search=Doe&status=due`
*   **Description**: Main data source for the "Reports" page.

---

## ☁️ Deployment

### Vercel (Serverless)
This project is pre-configured for Vercel via `vercel.json`.

1.  Install Vercel CLI: `npm i -g vercel`
2.  Run `vercel` in the root directory.
3.  Add your **Environment Variables** in the Vercel Dashboard (Settings > Environment Variables).

### Standard VPS / VM
1.  Set up a process manager like **PM2**: `npm i -g pm2`
2.  Start the app: `pm2 start index.js --name "hospital-crm-server"`
3.  Configure Nginx as a reverse proxy if needed.

---

## 🤝 Contributing

1.  Fork the repository.
2.  Create your feature branch (`git checkout -b feature/AmazingFeature`).
3.  Commit your changes (`git commit -m 'Add some AmazingFeature'`).
4.  Push to the branch (`git push origin feature/AmazingFeature`).
5.  Open a Pull Request.

---

## 📄 License

This project is licensed under the **PolyForm Noncommercial License 1.0.0**.

*   **Allowed**: Personal use, educational use, and non-profit research.
*   **Prohibited**: Commercial use, for-profit services, and selling the software.

See the [LICENSE.md](LICENSE.md) file for details.
